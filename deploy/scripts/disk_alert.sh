#!/usr/bin/env bash
# 磁盘用量告警：默认监控 /data，阈值 85%。
set -euo pipefail

MOUNT="${DISK_ALERT_MOUNT:-/data}"
THRESHOLD="${DISK_ALERT_THRESHOLD:-85}"
WEBHOOK="${HEALTH_WEBHOOK_URL:-${DISK_ALERT_WEBHOOK:-}}"
LOG="${DISK_ALERT_LOG:-/opt/citysafe/current/logs/disk_alert.log}"

mkdir -p "$(dirname "${LOG}")"
PCT="$(df --output=pcent "${MOUNT}" 2>/dev/null | tail -1 | tr -dc '0-9' || echo 0)"
MSG="$(date '+%F %T') mount=${MOUNT} used=${PCT}% threshold=${THRESHOLD}%"

if [[ -z "${PCT}" ]]; then
  echo "${MSG} WARN cannot read df" >> "${LOG}"
  exit 0
fi

echo "${MSG}" >> "${LOG}"

if (( PCT >= THRESHOLD )); then
  ALERT="[citysafe] DISK ALERT ${MOUNT} ${PCT}% on $(hostname)"
  echo "${ALERT}" >> "${LOG}"
  if [[ -n "${WEBHOOK}" ]]; then
    curl -fsS -X POST -H 'Content-Type: application/json' \
      -d "{\"text\":\"${ALERT}\"}" "${WEBHOOK}" >/dev/null 2>&1 || true
  fi
  # 也可写到本地告警文件供外部采集
  echo "${ALERT}" > /tmp/citysafe_disk_alert.flag
  exit 2
fi

rm -f /tmp/citysafe_disk_alert.flag
exit 0
