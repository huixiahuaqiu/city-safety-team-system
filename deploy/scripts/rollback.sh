#!/usr/bin/env bash
# 版本回滚：切到上一版（或指定版本目录名），重启网关。
# 用法：
#   bash deploy/scripts/rollback.sh              # 回到倒数第二新
#   bash deploy/scripts/rollback.sh 2026-07-14_013000
set -euo pipefail

ROOT="${CITYSAFE_ROOT:-/opt/citysafe}"
TARGET="${1:-}"

if [[ -z "${TARGET}" ]]; then
  mapfile -t ALL < <(ls -1dt "${ROOT}/releases/"* 2>/dev/null || true)
  if (( ${#ALL[@]} < 2 )); then
    echo "ERROR: 不足两个版本，无法自动回滚" >&2
    exit 1
  fi
  TARGET_PATH="${ALL[1]}"
else
  if [[ -d "${ROOT}/releases/${TARGET}" ]]; then
    TARGET_PATH="${ROOT}/releases/${TARGET}"
  elif [[ -d "${TARGET}" ]]; then
    TARGET_PATH="${TARGET}"
  else
    echo "ERROR: 版本不存在: ${TARGET}" >&2
    ls -1dt "${ROOT}/releases/"* 2>/dev/null || true
    exit 1
  fi
fi

echo "[rollback] → ${TARGET_PATH}"
ln -sfn "${TARGET_PATH}" "${ROOT}/current"
ln -sfn "${ROOT}/current" "${ROOT}/app" 2>/dev/null || true

if command -v systemctl >/dev/null 2>&1; then
  sudo nginx -t 2>/dev/null && sudo systemctl reload nginx || true
  sudo systemctl restart citysafe-gateway
fi

echo "[rollback] OK current=$(readlink -f "${ROOT}/current")"
curl -fsS "http://127.0.0.1:8000/api/health" || echo "WARN: health check failed（网关可能仍在启动）"
