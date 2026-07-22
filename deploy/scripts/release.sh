#!/usr/bin/env bash
# 版本发布：rsync 到 releases/<时间戳>，切换 current 软链，重载 Nginx / 重启网关。
# 用法（在含 123123/ 的仓库根目录，或指定 SRC）：
#   sudo -u appsvc bash deploy/scripts/release.sh
#   SRC=/path/to/123123 sudo -u appsvc bash deploy/scripts/release.sh
set -euo pipefail

ROOT="${CITYSAFE_ROOT:-/opt/citysafe}"
SRC="${SRC:-}"
KEEP="${KEEP_RELEASES:-8}"
TS="$(date +%F_%H%M%S)"
REL="${ROOT}/releases/${TS}"

if [[ -z "${SRC}" ]]; then
  # 脚本位于 deploy/scripts/ → 仓库根/123123
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  CANDIDATE="$(cd "${SCRIPT_DIR}/../../123123" 2>/dev/null && pwd || true)"
  if [[ -n "${CANDIDATE}" && -f "${CANDIDATE}/working_proxy.py" ]]; then
    SRC="${CANDIDATE}"
  elif [[ -f "./123123/working_proxy.py" ]]; then
    SRC="$(pwd)/123123"
  else
    echo "ERROR: 找不到源码目录，请设置 SRC=/path/to/123123" >&2
    exit 1
  fi
fi

if [[ ! -f "${SRC}/working_proxy.py" ]]; then
  echo "ERROR: ${SRC} 不是有效的应用目录（缺 working_proxy.py）" >&2
  exit 1
fi

# 发布前按内容哈希刷新静态资源 ?v= 缓存戳，保证前端改动能绕过浏览器缓存。
# best-effort：失败只告警、沿用现有 ?v=，不阻断发布。
if command -v python3 >/dev/null 2>&1 && [[ -f "${SRC}/build_assets.py" ]]; then
  echo "[release] refresh cache-busting stamps"
  ( cd "${SRC}" && python3 build_assets.py ) || echo "[release] WARN: build_assets 执行失败，沿用现有 ?v="
fi

mkdir -p "${ROOT}/releases" "${REL}"
echo "[release] sync ${SRC} → ${REL}"
rsync -a --delete \
  --exclude '.env' \
  --exclude '.env.*' \
  --exclude 'uploads/' \
  --exclude 'logs/' \
  --exclude '__pycache__/' \
  --exclude 'mlops_store.json' \
  --exclude 'node_modules/' \
  "${SRC}/" "${REL}/"

# 外部敏感配置软链进版本目录（不随代码覆盖）
if [[ -f "${ROOT}/.env" ]]; then
  ln -sfn "${ROOT}/.env" "${REL}/.env"
fi

# 运行态数据目录：指向数据盘，避免写进 release。
# 审计日志与上传均持久化到 /data，不随 release 目录被 rm -rf 清理（合规留存见 deploy/logrotate/citysafe）。
mkdir -p /data/uploads/{shared,datasets,annotations} /data/logs 2>/dev/null || true
if [[ ! -e "${REL}/uploads" ]]; then
  ln -sfn /data/uploads "${REL}/uploads"
fi
# 审计日志持久化：current/logs → /data/logs（append-only 防篡改，见 install-base.sh）
if [[ ! -e "${REL}/logs" ]]; then
  ln -sfn /data/logs "${REL}/logs"
fi

PREV=""
if [[ -L "${ROOT}/current" ]]; then
  PREV="$(readlink -f "${ROOT}/current" || true)"
fi

ln -sfn "${REL}" "${ROOT}/current"
# 兼容旧文档中的 app 软链
ln -sfn "${ROOT}/current" "${ROOT}/app" 2>/dev/null || true

echo "[release] current → ${REL}"
if command -v systemctl >/dev/null 2>&1; then
  if systemctl is-active --quiet nginx 2>/dev/null; then
    sudo nginx -t && sudo systemctl reload nginx || true
  fi
  if systemctl list-unit-files | grep -q '^citysafe-gateway'; then
    sudo systemctl restart citysafe-gateway
  fi
fi

# 清理旧版本
mapfile -t ALL < <(ls -1dt "${ROOT}/releases/"* 2>/dev/null || true)
COUNT="${#ALL[@]}"
if (( COUNT > KEEP )); then
  for ((i=KEEP; i<COUNT; i++)); do
    OLD="${ALL[$i]}"
    if [[ -n "${PREV}" && "$(readlink -f "${OLD}" 2>/dev/null || true)" == "${PREV}" ]]; then
      continue
    fi
    echo "[release] prune ${OLD}"
    rm -rf "${OLD}"
  done
fi

echo "[release] OK 版本=${TS} 上一版=${PREV:-none}"
echo "[release] 回滚: bash ${ROOT}/current/../deploy/scripts/rollback.sh  或  bash deploy/scripts/rollback.sh"
