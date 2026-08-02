#!/usr/bin/env bash
# Restore a verified CitySafe v2 backup into the LIVE production Compose project.
#
# Required:
#   CONFIRM_PRODUCTION_RESTORE=YES
#   SOURCE_MINIO_ROOT_USER / SOURCE_MINIO_ROOT_PASSWORD
#     (MinIO root credentials that match the backup's MinIO volume; usually from
#      the workstation .env.local used to create the backup)
#
# Preserves /etc/citysafe/server.env application secrets (AUTH, tokens,
# MINIO_ACCESS_KEY/SECRET, Postgres role password). After a successful restore,
# MINIO_ROOT_* in server.env are updated to the SOURCE values so future
# minio-init/backup runs can authenticate against the restored volume.
#
# Usage:
#   sudo env CONFIRM_PRODUCTION_RESTORE=YES \
#     SOURCE_MINIO_ROOT_USER=... SOURCE_MINIO_ROOT_PASSWORD=... \
#     bash deploy/scripts/restore-production.sh /srv/citysafe/backups/citysafe_....tar.gz
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
DEPLOY_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"
COMPOSE_FILE="${CITYSAFE_COMPOSE_FILE:-${DEPLOY_DIR}/compose.yaml}"
SERVER_OVERRIDE="${CITYSAFE_SERVER_OVERRIDE:-${DEPLOY_DIR}/compose.server.yaml}"
ENV_FILE="${CITYSAFE_ENV_FILE:-/etc/citysafe/server.env}"
HEALTH_TIMEOUT="${RESTORE_PRODUCTION_HEALTH_TIMEOUT_SECONDS:-300}"
MAINTENANCE_LOCK_DIR="/run/lock/citysafe"
MAINTENANCE_LOCK_FILE="${MAINTENANCE_LOCK_DIR}/maintenance.lock"
ARCHIVER_IMAGE="${CITYSAFE_ARCHIVER_IMAGE:-}"

log() {
  printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"
}

die() {
  log "ERROR: $*"
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command is missing: $1"
}

require_safe_file() {
  local path="$1"
  local label="$2"
  [[ -f "${path}" && ! -L "${path}" ]] || die "${label} must be a regular, non-symlink file: ${path}"
}

replace_env_keys() {
  local tmp
  tmp="$(mktemp "${ENV_FILE}.XXXXXX")"
  grep -vE '^(MINIO_ROOT_USER|MINIO_ROOT_PASSWORD)=' "${ENV_FILE}" > "${tmp}"
  printf 'MINIO_ROOT_USER=%s\n' "${SOURCE_MINIO_ROOT_USER}" >> "${tmp}"
  printf 'MINIO_ROOT_PASSWORD=%s\n' "${SOURCE_MINIO_ROOT_PASSWORD}" >> "${tmp}"
  chmod 0600 "${tmp}"
  mv -- "${tmp}" "${ENV_FILE}"
}

[[ "${EUID}" -eq 0 ]] || die "run production restore with sudo/root"
[[ "${CONFIRM_PRODUCTION_RESTORE:-}" == "YES" ]] \
  || die "refusing to modify production; set CONFIRM_PRODUCTION_RESTORE=YES"
[[ -n "${SOURCE_MINIO_ROOT_USER:-}" && -n "${SOURCE_MINIO_ROOT_PASSWORD:-}" ]] \
  || die "SOURCE_MINIO_ROOT_USER and SOURCE_MINIO_ROOT_PASSWORD are required"
require_command docker
require_command sha256sum
require_command tar
require_command flock
require_command stat
require_command curl
require_safe_file "${COMPOSE_FILE}" "base Compose file"
require_safe_file "${SERVER_OVERRIDE}" "server Compose override"
require_safe_file "${ENV_FILE}" "external environment file"

ARCHIVE="${1:-}"
[[ -n "${ARCHIVE}" ]] || die "usage: restore-production.sh <verified-archive.tar.gz>"
require_safe_file "${ARCHIVE}" "backup archive"
ARCHIVE_DIR="$(cd -- "$(dirname -- "${ARCHIVE}")" && pwd -P)"
ARCHIVE="${ARCHIVE_DIR}/$(basename -- "${ARCHIVE}")"
CHECKSUM="${ARCHIVE}.sha256"
MARKER="${ARCHIVE}.verified"
require_safe_file "${CHECKSUM}" "archive checksum"
require_safe_file "${MARKER}" "archive verification marker"

if [[ ! -e "${MAINTENANCE_LOCK_DIR}" && ! -L "${MAINTENANCE_LOCK_DIR}" ]]; then
  mkdir -- "${MAINTENANCE_LOCK_DIR}" 2>/dev/null || true
fi
[[ -d "${MAINTENANCE_LOCK_DIR}" && ! -L "${MAINTENANCE_LOCK_DIR}" ]] \
  || die "maintenance lock directory is not a real directory"
[[ "$(stat -c '%u' -- "${MAINTENANCE_LOCK_DIR}")" == "0" ]] \
  || die "maintenance lock directory must be owned by root"
chmod 0700 -- "${MAINTENANCE_LOCK_DIR}"
exec 8>"${MAINTENANCE_LOCK_FILE}"
chmod 0600 -- "${MAINTENANCE_LOCK_FILE}"
flock -n 8 || die "another CitySafe deployment, backup, or restore is in progress"

ARCHIVE_BASENAME="$(basename -- "${ARCHIVE}")"
MARKED_ARCHIVE="$(sed -n 's/^archive=//p' "${MARKER}")"
MARKED_SHA256="$(sed -n 's/^sha256=//p' "${MARKER}")"
[[ "${MARKED_ARCHIVE}" == "${ARCHIVE_BASENAME}" ]] \
  || die "verification marker does not name this archive"
[[ "${MARKED_SHA256}" =~ ^[0-9a-f]{64}$ ]] \
  || die "verification marker has an invalid SHA256"
CHECKSUM_SHA256="$(awk 'NR == 1 {print $1}' "${CHECKSUM}")"
CHECKSUM_ARCHIVE="$(awk 'NR == 1 {sub(/^[^[:space:]]+[[:space:]]+\*?/, ""); print}' "${CHECKSUM}")"
[[ "${CHECKSUM_SHA256}" == "${MARKED_SHA256}" && "${CHECKSUM_ARCHIVE}" == "${ARCHIVE_BASENAME}" ]] \
  || die "archive checksum metadata is inconsistent"
ACTUAL_SHA256="$(sha256sum "${ARCHIVE}" | awk '{print $1}')"
[[ "${ACTUAL_SHA256}" == "${MARKED_SHA256}" ]] \
  || die "archive does not match its verification marker"

PROJECT_NAME="$(
  awk -F= '$1 == "COMPOSE_PROJECT_NAME" {print $2; exit}' "${ENV_FILE}"
)"
[[ -n "${PROJECT_NAME}" ]] || PROJECT_NAME="citysafe"
[[ "${PROJECT_NAME}" =~ ^[A-Za-z0-9][A-Za-z0-9_-]*$ ]] \
  || die "unsafe COMPOSE_PROJECT_NAME in ${ENV_FILE}"

WORK="$(mktemp -d /tmp/citysafe-restore-production.XXXXXX)"
chmod 700 "${WORK}"
RESTORE_ENV="${WORK}/restore.env"
# Overlay MinIO root so the restored volume can be opened and minio-init can run.
grep -vE '^(MINIO_ROOT_USER|MINIO_ROOT_PASSWORD)=' "${ENV_FILE}" > "${RESTORE_ENV}"
printf 'MINIO_ROOT_USER=%s\n' "${SOURCE_MINIO_ROOT_USER}" >> "${RESTORE_ENV}"
printf 'MINIO_ROOT_PASSWORD=%s\n' "${SOURCE_MINIO_ROOT_PASSWORD}" >> "${RESTORE_ENV}"
chmod 0600 "${RESTORE_ENV}"

COMPOSE=(
  docker compose
  --project-name "${PROJECT_NAME}"
  --env-file "${RESTORE_ENV}"
  -f "${COMPOSE_FILE}"
  -f "${SERVER_OVERRIDE}"
)

cleanup() {
  local rc=$?
  trap - EXIT
  rm -rf -- "${WORK}" 2>/dev/null || true
  exit "${rc}"
}
trap cleanup EXIT

log "extracting ${ARCHIVE_BASENAME}"
tar -C "${WORK}" -xzf "${ARCHIVE}"
PAYLOAD="$(find "${WORK}" -mindepth 1 -maxdepth 1 -type d -name 'citysafe-backup-*' | head -n 1)"
[[ -n "${PAYLOAD}" && -d "${PAYLOAD}" ]] || die "backup payload directory missing"
require_safe_file "${PAYLOAD}/manifest.json" "backup manifest"
require_safe_file "${PAYLOAD}/SHA256SUMS" "internal checksum manifest"
grep -q '"formatVersion": 2' "${PAYLOAD}/manifest.json" || die "unsupported backup format"
grep -q '"environmentFileIncluded": false' "${PAYLOAD}/manifest.json" \
  || die "backup manifest does not confirm environment-file exclusion"
(
  cd -- "${PAYLOAD}"
  sha256sum --check SHA256SUMS >/dev/null
)

mount_volume_name() {
  local cid="$1"
  local destination="$2"
  local volume
  volume="$(
    docker inspect \
      --format "{{range .Mounts}}{{if eq .Destination \"${destination}\"}}{{.Name}}{{end}}{{end}}" \
      "${cid}"
  )"
  [[ "${volume}" =~ ^[A-Za-z0-9_.-]+$ ]] \
    || die "could not resolve volume for ${destination}"
  printf '%s\n' "${volume}"
}

assert_project_volume() {
  local volume="$1"
  local actual_project
  actual_project="$(
    docker volume inspect \
      --format '{{index .Labels "com.docker.compose.project"}}' \
      "${volume}"
  )"
  [[ "${actual_project}" == "${PROJECT_NAME}" ]] \
    || die "refused to touch volume outside project ${PROJECT_NAME}: ${volume}"
}

restore_volume_archive() {
  local logical_name="$1"
  local volume="$2"
  assert_project_volume "${volume}"
  docker run --rm -i --network none --entrypoint sh \
    --mount "type=volume,src=${volume},dst=/target" \
    "${ARCHIVER_IMAGE}" \
    -ceu 'rm -rf /target/..?* /target/.[!.]* /target/* 2>/dev/null || true; exec tar -C /target -xzf -' \
    < "${PAYLOAD}/volumes/${logical_name}.tar.gz"
}

wait_for_service() {
  local service="$1"
  local deadline=$((SECONDS + HEALTH_TIMEOUT))
  local cid status
  while (( SECONDS < deadline )); do
    cid="$("${COMPOSE[@]}" ps -q "${service}")"
    if [[ -n "${cid}" ]]; then
      status="$(
        docker inspect \
          --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
          "${cid}"
      )"
      if [[ "${status}" == "healthy" || "${status}" == "running" ]]; then
        return 0
      fi
      if [[ "${status}" == "unhealthy" || "${status}" == "exited" || "${status}" == "dead" ]]; then
        die "${service} entered state ${status}"
      fi
    fi
    sleep 2
  done
  die "timed out waiting for ${service}"
}

run_oneshot() {
  local service="$1"
  local cid exit_code
  log "running one-shot service: ${service}"
  "${COMPOSE[@]}" create --no-build "${service}"
  cid="$("${COMPOSE[@]}" ps -aq "${service}")"
  [[ -n "${cid}" ]] || die "could not create ${service}"
  docker start --attach "${cid}" || die "${service} failed to start"
  exit_code="$(docker inspect --format '{{.State.ExitCode}}' "${cid}")"
  [[ "${exit_code}" == "0" ]] || die "${service} exited with code ${exit_code}"
}

log "stopping production stack ${PROJECT_NAME}"
"${COMPOSE[@]}" down --remove-orphans || true

log "removing production data volumes for ${PROJECT_NAME}"
mapfile -t PROD_VOLUMES < <(
  docker volume ls \
    --filter "label=com.docker.compose.project=${PROJECT_NAME}" \
    --format '{{.Name}}'
)
for volume_name in "${PROD_VOLUMES[@]:-}"; do
  [[ -n "${volume_name}" ]] || continue
  [[ "${volume_name}" =~ ^[A-Za-z0-9_.-]+$ ]] || die "unsafe volume name: ${volume_name}"
  assert_project_volume "${volume_name}"
  log "removing volume ${volume_name}"
  docker volume rm -- "${volume_name}" >/dev/null
done

log "creating empty db/minio targets"
"${COMPOSE[@]}" create --no-build db minio
DB_CID="$("${COMPOSE[@]}" ps -aq db)"
MINIO_CID="$("${COMPOSE[@]}" ps -aq minio)"
[[ -n "${DB_CID}" && -n "${MINIO_CID}" ]] || die "could not create db/minio"
MINIO_VOLUME="$(mount_volume_name "${MINIO_CID}" "/data")"
assert_project_volume "${MINIO_VOLUME}"
if [[ -z "${ARCHIVER_IMAGE}" ]]; then
  ARCHIVER_IMAGE="$(docker inspect --format '{{.Config.Image}}' "${DB_CID}")"
fi
[[ "${ARCHIVER_IMAGE}" =~ ^[A-Za-z0-9._/@:+-]+$ ]] \
  || die "database container uses an unsafe image reference"

log "restoring MinIO volume"
restore_volume_archive minio "${MINIO_VOLUME}"

log "starting db and MinIO"
"${COMPOSE[@]}" start db minio
wait_for_service db
wait_for_service minio

log "restoring PostgreSQL"
"${COMPOSE[@]}" exec -T db sh -ceu '
  exec pg_restore \
    --exit-on-error \
    --no-owner \
    --no-privileges \
    --username="${POSTGRES_USER}" \
    --dbname="${POSTGRES_DB}"
' < "${PAYLOAD}/postgres/database.dump"

run_oneshot migrate
run_oneshot minio-init

log "creating gateway and restoring application volumes"
"${COMPOSE[@]}" create --no-build --no-deps gateway
GATEWAY_CID="$("${COMPOSE[@]}" ps -aq gateway)"
[[ -n "${GATEWAY_CID}" ]] || die "could not create gateway"
STATE_VOLUME="$(mount_volume_name "${GATEWAY_CID}" "/data")"
UPLOADS_VOLUME="$(mount_volume_name "${GATEWAY_CID}" "/data/uploads")"
LOGS_VOLUME="$(mount_volume_name "${GATEWAY_CID}" "/data/logs")"
restore_volume_archive state "${STATE_VOLUME}"
restore_volume_archive uploads "${UPLOADS_VOLUME}"
restore_volume_archive logs "${LOGS_VOLUME}"

log "persisting SOURCE MinIO root credentials into ${ENV_FILE}"
replace_env_keys

# Final stack uses the updated server.env (same MinIO root as restored volume).
COMPOSE=(
  docker compose
  --project-name "${PROJECT_NAME}"
  --env-file "${ENV_FILE}"
  -f "${COMPOSE_FILE}"
  -f "${SERVER_OVERRIDE}"
)

log "starting full production stack"
"${COMPOSE[@]}" up -d --no-build --wait
"${COMPOSE[@]}" up -d --no-deps --force-recreate --wait edge

SERVER_NAME="$(awk -F= '$1 == "SERVER_NAME" {print $2; exit}' "${ENV_FILE}")"
[[ -n "${SERVER_NAME}" ]] || die "SERVER_NAME missing from ${ENV_FILE}"
curl --fail --silent --show-error --max-time 30 -k \
  --resolve "${SERVER_NAME}:443:127.0.0.1" \
  "https://${SERVER_NAME}/api/health" >/dev/null

log "checking restored business data"
"${COMPOSE[@]}" exec -T gateway python -c '
import data_store
assert data_store.healthcheck(), "database health check failed"
accounts = data_store.load_accounts()
assert accounts, "account table is empty after restore"
sync_items = data_store.list_sync_values()
print("production restore data check PASS: accounts=%d sync_keys=%d" % (len(accounts), len(sync_items)))
'

log "production restore complete: ${ARCHIVE_BASENAME}"
log "login with accounts from the restored database (bootstrap admin password no longer applies)"
