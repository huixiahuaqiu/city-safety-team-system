#!/usr/bin/env bash
# 备份恢复演练：取最新备份归档，（可选）解密 → 解包 → 校验关键内容是否可还原。
# 只读演练，不覆盖生产数据；用于定期确认“备份有效”，避免备份无效的运维事故。
# 用法：
#   BACKUP_ENCRYPT_KEY_FILE=/opt/citysafe/backup.key bash deploy/scripts/restore-verify.sh
#   bash deploy/scripts/restore-verify.sh /data/backups/citysafe_2026-07-20_0100.tar.gz.enc
set -euo pipefail

BACKUP_ROOT="${BACKUP_ROOT:-/data/backups}"
LOG="${RESTORE_VERIFY_LOG:-/data/logs/restore-verify.log}"
WEBHOOK="${HEALTH_WEBHOOK_URL:-}"
mkdir -p "$(dirname "${LOG}")"
ts() { date '+%F %T'; }
log() { echo "$(ts) $*" | tee -a "${LOG}"; }

ARCHIVE="${1:-}"
if [[ -z "${ARCHIVE}" ]]; then
  ARCHIVE="$(ls -1t "${BACKUP_ROOT}"/citysafe_*.tar.gz* 2>/dev/null | head -n1 || true)"
fi
if [[ -z "${ARCHIVE}" || ! -f "${ARCHIVE}" ]]; then
  log "FAIL: 找不到备份归档（BACKUP_ROOT=${BACKUP_ROOT}）"
  exit 1
fi

# 备份新鲜度（近似 RPO）：超过 26 小时告警
AGE_H=$(( ( $(date +%s) - $(stat -c %Y "${ARCHIVE}") ) / 3600 ))
log "演练开始：archive=${ARCHIVE} 年龄=${AGE_H}h"
[[ "${AGE_H}" -gt 26 ]] && log "WARN: 最近备份已 ${AGE_H} 小时，RPO 可能不达标"

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
FAIL=0
START=$(date +%s)

TARBALL="${ARCHIVE}"
if [[ "${ARCHIVE}" == *.enc ]]; then
  if [[ -z "${BACKUP_ENCRYPT_KEY_FILE:-}" || ! -f "${BACKUP_ENCRYPT_KEY_FILE}" ]]; then
    log "FAIL: 归档已加密但未提供 BACKUP_ENCRYPT_KEY_FILE"
    exit 1
  fi
  TARBALL="${WORK}/decrypted.tar.gz"
  if ! openssl enc -d -aes-256-cbc -pbkdf2 -pass "file:${BACKUP_ENCRYPT_KEY_FILE}" -in "${ARCHIVE}" -out "${TARBALL}"; then
    log "FAIL: 解密失败（密钥不匹配或归档损坏）"
    exit 1
  fi
  log "解密 OK"
fi

if ! tar -tzf "${TARBALL}" >/dev/null 2>&1; then
  log "FAIL: 归档不可解包（tar 校验失败）"
  exit 1
fi
tar -C "${WORK}" -xzf "${TARBALL}"
log "解包 OK"

# 关键内容校验：注册表 + 配置快照 + 审计日志
REG_COUNT=$(find "${WORK}" -name '*_registry.json' 2>/dev/null | wc -l | tr -d ' ')
HAS_CONFIG=$(find "${WORK}" -path '*/config/citysafe.conf' 2>/dev/null | head -n1 || true)
HAS_AUDIT=$(find "${WORK}" -path '*/audit-logs/*' 2>/dev/null | head -n1 || true)

[[ "${REG_COUNT}" -ge 1 ]] && log "OK: 注册表快照 ${REG_COUNT} 份" || { log "WARN: 未发现 *_registry.json"; FAIL=1; }
[[ -n "${HAS_CONFIG}" ]] && log "OK: 配置快照存在" || log "WARN: 未发现 config/citysafe.conf 快照"
[[ -n "${HAS_AUDIT}" ]] && log "OK: 审计日志已纳入备份" || { log "WARN: 未发现 audit-logs（检查 backup.sh 是否已纳入 /data/logs）"; FAIL=1; }

# 若注册表为 JSON，做一次可解析校验（还原可用性的最小证明）
while IFS= read -r reg; do
  if command -v python3 >/dev/null 2>&1; then
    python3 -c "import json,sys; json.load(open(sys.argv[1],encoding='utf-8'))" "${reg}" \
      && log "OK: 可解析 $(basename "${reg}")" \
      || { log "FAIL: 注册表损坏 $(basename "${reg}")"; FAIL=1; }
  fi
done < <(find "${WORK}" -name '*_registry.json' 2>/dev/null)

RTO=$(( $(date +%s) - START ))
log "演练结束：耗时(近似RTO)=${RTO}s 结果=$([[ ${FAIL} -eq 0 ]] && echo PASS || echo FAIL)"

if (( FAIL == 1 )) && [[ -n "${WEBHOOK}" ]]; then
  curl -fsS -X POST -H 'Content-Type: application/json' \
    -d "{\"text\":\"[citysafe] 备份恢复演练 FAILED archive=${ARCHIVE}\"}" \
    "${WEBHOOK}" >/dev/null 2>&1 || true
fi
exit "${FAIL}"
