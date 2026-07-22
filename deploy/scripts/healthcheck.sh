#!/usr/bin/env bash
# 健康探测：网关 / Nginx /（可选）MinIO。失败时写日志并可选 webhook。
set -euo pipefail

GATEWAY_URL="${GATEWAY_HEALTH_URL:-http://127.0.0.1:8000/api/health}"
NGINX_URL="${NGINX_HEALTH_URL:-http://127.0.0.1/api/health}"
WEBHOOK="${HEALTH_WEBHOOK_URL:-}"
LOG="${HEALTH_LOG:-/opt/citysafe/current/logs/health.log}"
FAIL=0

mkdir -p "$(dirname "${LOG}")"
ts() { date '+%F %T'; }

check() {
  local name="$1" url="$2"
  local body
  body="$(curl -fsS --max-time 8 "${url}" 2>/dev/null || true)"
  if echo "${body}" | grep -q '"ok"[[:space:]]*:[[:space:]]*true'; then
    if echo "${body}" | grep -q '"degraded"[[:space:]]*:[[:space:]]*true'; then
      # 进程存活但依赖未就绪 / 磁盘高水位 —— 记 WARN 并触发告警，但不重启服务
      echo "$(ts) WARN ${name} degraded body=${body:0:200}" >> "${LOG}"
      FAIL=1
      return 0
    fi
    echo "$(ts) OK ${name}" >> "${LOG}"
    return 0
  fi
  echo "$(ts) FAIL ${name} url=${url} body=${body:0:200}" >> "${LOG}"
  FAIL=1
  return 1
}

check gateway "${GATEWAY_URL}" || true
# Nginx 可能未配 80，失败不强制
curl -fsS --max-time 5 "${NGINX_URL}" >/dev/null 2>&1 && echo "$(ts) OK nginx" >> "${LOG}" || echo "$(ts) WARN nginx unreachable" >> "${LOG}"

if command -v systemctl >/dev/null 2>&1; then
  for u in citysafe-gateway nginx minio; do
    if systemctl list-unit-files | grep -q "^${u}"; then
      if systemctl is-active --quiet "${u}"; then
        echo "$(ts) OK unit ${u}" >> "${LOG}"
      else
        echo "$(ts) FAIL unit ${u}" >> "${LOG}"
        FAIL=1
      fi
    fi
  done
fi

if (( FAIL == 1 )) && [[ -n "${WEBHOOK}" ]]; then
  curl -fsS -X POST -H 'Content-Type: application/json' \
    -d "{\"text\":\"[citysafe] health check FAILED on $(hostname) at $(ts)\"}" \
    "${WEBHOOK}" >/dev/null 2>&1 || true
fi

exit "${FAIL}"
