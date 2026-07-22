#!/usr/bin/env bash
# 3-2-1 备份：本地快照 +（可选）MinIO 镜像 +（可选）Postgres dump +（可选）异地 rsync。
# 依赖环境变量见 deploy/.env.production.example 中 BACKUP_* 段。
# crontab 示例见 deploy/cron/citysafe.cron
set -euo pipefail

ROOT="${CITYSAFE_ROOT:-/opt/citysafe}"
BACKUP_ROOT="${BACKUP_ROOT:-/data/backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-7}"
TS="$(date +%F_%H%M)"
DST="${BACKUP_ROOT}/${TS}"
LOG_DIR="${ROOT}/current/logs"
mkdir -p "${DST}" "${LOG_DIR}"

log() { echo "[$(date '+%F %T')] $*"; }

log "backup start → ${DST}"

# 1) 小而关键的状态文件
APP="${ROOT}/current"
mkdir -p "${DST}/state"
find /data/uploads -name '_registry.json' -o -name '*_registry.json' 2>/dev/null \
  | while read -r f; do
      cp -a "$f" "${DST}/state/" 2>/dev/null || true
    done
[[ -f "${APP}/mlops_store.json" ]] && cp -a "${APP}/mlops_store.json" "${DST}/state/" || true
[[ -f "${ROOT}/.env" ]] && cp -a "${ROOT}/.env" "${DST}/state/env.redacted.copy" || true
# 配置快照（不含私钥内容时可另拷）
mkdir -p "${DST}/config"
cp -a /etc/nginx/sites-available/citysafe.conf "${DST}/config/" 2>/dev/null || true
cp -a /etc/systemd/system/citysafe-gateway.service "${DST}/config/" 2>/dev/null || true

# 1b) 审计日志纳入备份（合规红线：独立留存 + 随归档统一加密 + 异地）。
# append-only 文件可正常读取复制；轮转历史（*.gz）一并纳入，满足事后追溯。
if [[ -d /data/logs ]]; then
  mkdir -p "${DST}/audit-logs"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a /data/logs/ "${DST}/audit-logs/" 2>/dev/null || log "WARN: audit log backup failed"
  else
    cp -a /data/logs/. "${DST}/audit-logs/" 2>/dev/null || log "WARN: audit log backup failed"
  fi
fi

# 2) 本地 uploads 增量（大文件，慎用全量；默认 rsync 到备份盘）
if [[ "${BACKUP_UPLOADS:-1}" == "1" ]]; then
  mkdir -p "${BACKUP_ROOT}/uploads-mirror"
  rsync -a --delete /data/uploads/ "${BACKUP_ROOT}/uploads-mirror/" || log "WARN: uploads rsync failed"
fi

# 3) MinIO 镜像到异地 alias（需预先 mc alias set）
if [[ -n "${BACKUP_MC_SRC:-}" && -n "${BACKUP_MC_DST:-}" ]]; then
  if command -v mc >/dev/null 2>&1; then
    log "mc mirror ${BACKUP_MC_SRC} → ${BACKUP_MC_DST}"
    mc mirror --overwrite --remove "${BACKUP_MC_SRC}" "${BACKUP_MC_DST}" || log "WARN: mc mirror failed"
  else
    log "WARN: mc not found, skip MinIO mirror"
  fi
fi

# 4) Postgres / 自建 Supabase
if [[ -n "${BACKUP_PG_URL:-}" ]]; then
  if command -v pg_dump >/dev/null 2>&1; then
    log "pg_dump"
    pg_dump "${BACKUP_PG_URL}" | gzip > "${DST}/pg.sql.gz" || log "WARN: pg_dump failed"
  else
    log "WARN: pg_dump not found"
  fi
fi

# 5) 打包 + 可选加密推异地
ARCHIVE="${BACKUP_ROOT}/citysafe_${TS}.tar.gz"
tar -C "${BACKUP_ROOT}" -czf "${ARCHIVE}" "${TS}"
rm -rf "${DST}"

if [[ -n "${BACKUP_ENCRYPT_KEY_FILE:-}" && -f "${BACKUP_ENCRYPT_KEY_FILE}" ]]; then
  ENC="${ARCHIVE}.enc"
  openssl enc -aes-256-cbc -pbkdf2 -pass "file:${BACKUP_ENCRYPT_KEY_FILE}" -in "${ARCHIVE}" -out "${ENC}"
  rm -f "${ARCHIVE}"
  ARCHIVE="${ENC}"
fi

if [[ -n "${BACKUP_OFFSITE_RSYNC:-}" ]]; then
  log "rsync offsite → ${BACKUP_OFFSITE_RSYNC}"
  rsync -a -e ssh "${ARCHIVE}" "${BACKUP_OFFSITE_RSYNC}/" || log "WARN: offsite rsync failed"
fi

# 6) 本地保留
find "${BACKUP_ROOT}" -maxdepth 1 \( -name 'citysafe_*.tar.gz' -o -name 'citysafe_*.tar.gz.enc' \) -mtime "+${KEEP_DAYS}" -delete 2>/dev/null || true
find "${BACKUP_ROOT}" -maxdepth 1 -type d -name '20*' -mtime "+${KEEP_DAYS}" -exec rm -rf {} + 2>/dev/null || true

log "backup done: ${ARCHIVE}"
