#!/usr/bin/env bash
# MinIO 首次初始化：建桶、禁匿名、建业务账号。
# 用法：
#   export MINIO_ROOT_USER=... MINIO_ROOT_PASSWORD=...
#   export APP_ACCESS_KEY=... APP_SECRET_KEY=...
#   bash deploy/minio/init-bucket.sh
set -euo pipefail

ENDPOINT="${MINIO_ENDPOINT:-http://127.0.0.1:9000}"
BUCKET="${MINIO_BUCKET:-team-shared}"
POLICY_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/policy-team-shared.json"

: "${MINIO_ROOT_USER:?}"
: "${MINIO_ROOT_PASSWORD:?}"
: "${APP_ACCESS_KEY:?}"
: "${APP_SECRET_KEY:?}"

command -v mc >/dev/null || { echo "请先安装 mc 客户端"; exit 1; }

mc alias set local "${ENDPOINT}" "${MINIO_ROOT_USER}" "${MINIO_ROOT_PASSWORD}"
mc mb -p "local/${BUCKET}" || true
mc anonymous set none "local/${BUCKET}"
mc version enable "local/${BUCKET}" || true
mc admin user add local "${APP_ACCESS_KEY}" "${APP_SECRET_KEY}" || true
mc admin policy create local team-shared-rw "${POLICY_FILE}" || true
mc admin policy attach local team-shared-rw --user "${APP_ACCESS_KEY}" || true
mc ilm rule add "local/${BUCKET}" --noncurrent-expire-days 90 || true

echo "OK: bucket=${BUCKET} user=${APP_ACCESS_KEY}"
echo "把 APP_ACCESS_KEY/SECRET 写入 /opt/citysafe/.env 的 MINIO_ACCESS_KEY/MINIO_SECRET_KEY"
