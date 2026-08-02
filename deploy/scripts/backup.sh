#!/usr/bin/env bash
# CitySafe full-stack backup for the unified Docker Compose deployment.
#
# Required:
#   CITYSAFE_ENV_FILE=/etc/citysafe/server.env
#   BACKUP_ROOT=/srv/citysafe/backups
#
# The environment file is used only by Docker Compose. It is never copied into
# the backup. The gateway and MinIO are stopped briefly so the four filesystem
# volumes form a stable snapshot; PostgreSQL is dumped with pg_dump's
# transaction-consistent custom format.
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
DEPLOY_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"
COMPOSE_FILE="${CITYSAFE_COMPOSE_FILE:-${DEPLOY_DIR}/compose.yaml}"
SERVER_OVERRIDE="${CITYSAFE_SERVER_OVERRIDE:-${DEPLOY_DIR}/compose.server.yaml}"
ENV_FILE="${CITYSAFE_ENV_FILE:-/etc/citysafe/server.env}"
BACKUP_ROOT_INPUT="${BACKUP_ROOT:-/srv/citysafe/backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
QUIESCE_TIMEOUT="${BACKUP_QUIESCE_TIMEOUT_SECONDS:-60}"
HEALTH_TIMEOUT="${BACKUP_HEALTH_TIMEOUT_SECONDS:-180}"
OFFSITE_RSYNC="${BACKUP_OFFSITE_RSYNC:-}"
ENCRYPT_KEY_FILE="${BACKUP_ENCRYPT_KEY_FILE:-}"
MAINTENANCE_LOCK_DIR="/run/lock/citysafe"
MAINTENANCE_LOCK_FILE="${MAINTENANCE_LOCK_DIR}/maintenance.lock"

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

require_uint() {
  local name="$1"
  local value="$2"
  [[ "${value}" =~ ^[0-9]+$ ]] || die "${name} must be a non-negative integer"
}

require_safe_file() {
  local path="$1"
  local label="$2"
  [[ -f "${path}" && ! -L "${path}" ]] || die "${label} must be a regular, non-symlink file: ${path}"
}

prepare_maintenance_lock() {
  # /run/lock is commonly writable by non-root users. Never open a predictable
  # lock file there directly: a planted symlink could make root truncate an
  # unrelated file. The fixed root-owned 0700 directory makes the final open
  # safe against that race.
  if [[ ! -e "${MAINTENANCE_LOCK_DIR}" && ! -L "${MAINTENANCE_LOCK_DIR}" ]]; then
    mkdir -- "${MAINTENANCE_LOCK_DIR}" 2>/dev/null || true
  fi
  [[ -d "${MAINTENANCE_LOCK_DIR}" && ! -L "${MAINTENANCE_LOCK_DIR}" ]] \
    || die "maintenance lock directory is not a real directory"
  [[ "$(stat -c '%u' -- "${MAINTENANCE_LOCK_DIR}")" == "0" ]] \
    || die "maintenance lock directory must be owned by root"
  chmod 0700 -- "${MAINTENANCE_LOCK_DIR}"
  [[ ! -L "${MAINTENANCE_LOCK_FILE}" ]] \
    || die "maintenance lock file may not be a symlink"
  [[ ! -e "${MAINTENANCE_LOCK_FILE}" || -f "${MAINTENANCE_LOCK_FILE}" ]] \
    || die "maintenance lock path must be a regular file"
}

[[ "${EUID}" -eq 0 ]] || die "run this backup with sudo/root"
require_command docker
require_command gzip
require_command sha256sum
require_command tar
require_command flock
require_command stat
require_uint "BACKUP_KEEP_DAYS" "${KEEP_DAYS}"
require_uint "BACKUP_QUIESCE_TIMEOUT_SECONDS" "${QUIESCE_TIMEOUT}"
require_uint "BACKUP_HEALTH_TIMEOUT_SECONDS" "${HEALTH_TIMEOUT}"
require_safe_file "${COMPOSE_FILE}" "base Compose file"
require_safe_file "${SERVER_OVERRIDE}" "server Compose override"
require_safe_file "${ENV_FILE}" "external environment file"
if [[ -n "${OFFSITE_RSYNC}" && -z "${ENCRYPT_KEY_FILE}" ]]; then
  die "BACKUP_ENCRYPT_KEY_FILE is required when BACKUP_OFFSITE_RSYNC is configured"
fi

prepare_maintenance_lock
exec 8>"${MAINTENANCE_LOCK_FILE}"
chmod 0600 -- "${MAINTENANCE_LOCK_FILE}"
flock -n 8 || die "another CitySafe deployment or backup is in progress"

mkdir -p -- "${BACKUP_ROOT_INPUT}"
BACKUP_ROOT="$(cd -- "${BACKUP_ROOT_INPUT}" && pwd -P)"
[[ "${BACKUP_ROOT}" != "/" ]] || die "BACKUP_ROOT may not be the filesystem root"
[[ "${BACKUP_ROOT}" != "${DEPLOY_DIR}" ]] || die "BACKUP_ROOT may not be the deployment source directory"
case "${BACKUP_ROOT}" in
  /var/lib/docker|/var/lib/docker/*)
    die "BACKUP_ROOT may not be inside Docker's internal storage"
    ;;
esac

docker compose version >/dev/null

exec 9>"${BACKUP_ROOT}/.backup.lock"
flock -n 9 || die "another backup is already running for ${BACKUP_ROOT}"

COMPOSE=(
  docker compose
  --env-file "${ENV_FILE}"
  -f "${COMPOSE_FILE}"
  -f "${SERVER_OVERRIDE}"
)
"${COMPOSE[@]}" config --quiet

service_container() {
  local service="$1"
  local cid
  cid="$("${COMPOSE[@]}" ps --status running -q "${service}")"
  [[ -n "${cid}" ]] || die "Compose service is not running: ${service}"
  printf '%s\n' "${cid}"
}

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
    || die "could not resolve a safe named volume for ${destination}"
  printf '%s\n' "${volume}"
}

container_health() {
  docker inspect \
    --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
    "$1"
}

wait_for_service() {
  local service="$1"
  local deadline=$((SECONDS + HEALTH_TIMEOUT))
  local cid status
  while (( SECONDS < deadline )); do
    cid="$("${COMPOSE[@]}" ps -q "${service}")"
    if [[ -n "${cid}" ]]; then
      status="$(container_health "${cid}")"
      if [[ "${status}" == "healthy" || "${status}" == "running" ]]; then
        return 0
      fi
      if [[ "${status}" == "unhealthy" || "${status}" == "exited" || "${status}" == "dead" ]]; then
        log "ERROR: ${service} entered state ${status}"
        return 1
      fi
    fi
    sleep 2
  done
  log "ERROR: timed out waiting for ${service}"
  return 1
}

DB_CID="$(service_container db)"
GATEWAY_CID="$(service_container gateway)"
MINIO_CID="$(service_container minio)"
wait_for_service db
wait_for_service gateway
wait_for_service minio

DB_VOLUME="$(mount_volume_name "${DB_CID}" "/var/lib/postgresql/data")"
MINIO_VOLUME="$(mount_volume_name "${MINIO_CID}" "/data")"
STATE_VOLUME="$(mount_volume_name "${GATEWAY_CID}" "/data")"
UPLOADS_VOLUME="$(mount_volume_name "${GATEWAY_CID}" "/data/uploads")"
LOGS_VOLUME="$(mount_volume_name "${GATEWAY_CID}" "/data/logs")"

[[ "${DB_VOLUME}" != "${MINIO_VOLUME}" ]] || die "database and MinIO unexpectedly share a volume"
[[ "${STATE_VOLUME}" != "${UPLOADS_VOLUME}" ]] || die "state and uploads unexpectedly share a volume"
[[ "${STATE_VOLUME}" != "${LOGS_VOLUME}" ]] || die "state and logs unexpectedly share a volume"
[[ "${UPLOADS_VOLUME}" != "${LOGS_VOLUME}" ]] || die "uploads and logs unexpectedly share a volume"

ARCHIVER_IMAGE="$(
  docker inspect --format '{{.Config.Image}}' "${DB_CID}"
)"
[[ "${ARCHIVER_IMAGE}" =~ ^[A-Za-z0-9._/@:+-]+$ ]] \
  || die "database container uses an unsafe image reference"
docker run --rm --network none --entrypoint sh "${ARCHIVER_IMAGE}" \
  -ceu 'command -v tar >/dev/null' >/dev/null

CREATED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
BACKUP_ID="$(date -u '+%Y%m%dT%H%M%SZ')_$(printf '%04x%04x' "${RANDOM}" "${RANDOM}")"
WORK="$(mktemp -d "${BACKUP_ROOT}/.citysafe-backup-${BACKUP_ID}.XXXXXX")"
PAYLOAD="${WORK}/citysafe-backup-${BACKUP_ID}"
mkdir -p -- "${PAYLOAD}/postgres" "${PAYLOAD}/volumes"

GATEWAY_STOPPED=0
MINIO_STOPPED=0

resume_services() {
  local failed=0
  if (( MINIO_STOPPED == 1 )); then
    log "restarting MinIO"
    if "${COMPOSE[@]}" start minio && wait_for_service minio; then
      MINIO_STOPPED=0
    else
      failed=1
    fi
  fi
  if (( GATEWAY_STOPPED == 1 )); then
    log "restarting gateway"
    if "${COMPOSE[@]}" start gateway && wait_for_service gateway; then
      GATEWAY_STOPPED=0
    else
      failed=1
    fi
  fi
  return "${failed}"
}

cleanup() {
  local rc=$?
  local cleanup_failed=0
  trap - EXIT HUP INT TERM
  set +e

  # Free a partial archive first. A full backup disk must not prevent the
  # quiesced application services from restarting.
  if [[ -n "${WORK:-}" && -d "${WORK}" ]]; then
    case "${WORK}" in
      "${BACKUP_ROOT}"/.citysafe-backup-*)
        if ! rm -rf -- "${WORK}"; then
          cleanup_failed=1
          log "ERROR: could not remove private backup work directory"
        fi
        ;;
      *)
        cleanup_failed=1
        log "ERROR: refused to remove unexpected work directory: ${WORK}"
        ;;
    esac
  fi

  if ! resume_services; then
    cleanup_failed=1
    log "ERROR: one or more quiesced services could not be restored"
  fi

  if (( cleanup_failed == 1 && rc == 0 )); then
    rc=1
  fi
  exit "${rc}"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

archive_volume() {
  local logical_name="$1"
  local volume_name="$2"
  local output="${PAYLOAD}/volumes/${logical_name}.tar.gz"
  log "archiving ${logical_name} volume"
  docker run --rm -i --network none --entrypoint sh \
    --mount "type=volume,src=${volume_name},dst=/source,readonly" \
    "${ARCHIVER_IMAGE}" \
    -ceu 'exec tar -C /source -cf - .' \
    | gzip -n -9 > "${output}"
  [[ -s "${output}" ]] || die "${logical_name} volume archive is empty"
  tar -tzf "${output}" >/dev/null
}

log "quiescing gateway before the coordinated backup"
GATEWAY_STOPPED=1
"${COMPOSE[@]}" stop --timeout "${QUIESCE_TIMEOUT}" gateway

log "creating transaction-consistent PostgreSQL dump"
"${COMPOSE[@]}" exec -T db sh -ceu '
  exec pg_dump \
    --format=custom \
    --compress=6 \
    --no-owner \
    --no-privileges \
    --username="${POSTGRES_USER}" \
    --dbname="${POSTGRES_DB}"
' > "${PAYLOAD}/postgres/database.dump"
[[ -s "${PAYLOAD}/postgres/database.dump" ]] || die "PostgreSQL dump is empty"
"${COMPOSE[@]}" exec -T db sh -ceu 'pg_restore --list >/dev/null' \
  < "${PAYLOAD}/postgres/database.dump"

log "stopping MinIO before its volume snapshot"
MINIO_STOPPED=1
"${COMPOSE[@]}" stop --timeout "${QUIESCE_TIMEOUT}" minio

archive_volume minio "${MINIO_VOLUME}"
archive_volume state "${STATE_VOLUME}"
archive_volume uploads "${UPLOADS_VOLUME}"
archive_volume logs "${LOGS_VOLUME}"

# Reduce the write outage before checksumming and packaging.
resume_services || die "services did not recover after the snapshot"

cat > "${PAYLOAD}/manifest.json" <<EOF
{
  "formatVersion": 2,
  "backupId": "${BACKUP_ID}",
  "createdAtUtc": "${CREATED_AT}",
  "database": {
    "format": "postgres-custom",
    "consistentSnapshot": true
  },
  "volumes": ["minio", "state", "uploads", "logs"],
  "environmentFileIncluded": false,
  "encryptionKeyFileIncluded": false
}
EOF

(
  cd -- "${PAYLOAD}"
  sha256sum \
    manifest.json \
    postgres/database.dump \
    volumes/minio.tar.gz \
    volumes/state.tar.gz \
    volumes/uploads.tar.gz \
    volumes/logs.tar.gz > SHA256SUMS
  sha256sum --check SHA256SUMS >/dev/null
)

PLAIN_ARCHIVE="${WORK}/citysafe_${BACKUP_ID}.tar.gz"
tar -C "${WORK}" -czf "${PLAIN_ARCHIVE}" "$(basename -- "${PAYLOAD}")"
tar -tzf "${PLAIN_ARCHIVE}" >/dev/null

if [[ -n "${ENCRYPT_KEY_FILE}" ]]; then
  require_command openssl
  require_safe_file "${ENCRYPT_KEY_FILE}" "backup encryption key"
  CANDIDATE="${WORK}/citysafe_${BACKUP_ID}.tar.gz.enc"
  log "encrypting backup"
  openssl enc -aes-256-cbc -pbkdf2 -salt -md sha256 \
    -pass "file:${ENCRYPT_KEY_FILE}" \
    -in "${PLAIN_ARCHIVE}" \
    -out "${CANDIDATE}"
  SELF_CHECK="${WORK}/self-check.tar.gz"
  openssl enc -d -aes-256-cbc -pbkdf2 -md sha256 \
    -pass "file:${ENCRYPT_KEY_FILE}" \
    -in "${CANDIDATE}" \
    -out "${SELF_CHECK}"
  tar -tzf "${SELF_CHECK}" >/dev/null
  rm -f -- "${PLAIN_ARCHIVE}" "${SELF_CHECK}"
else
  CANDIDATE="${PLAIN_ARCHIVE}"
fi

FINAL_ARCHIVE="${BACKUP_ROOT}/$(basename -- "${CANDIDATE}")"
FINAL_CHECKSUM="${FINAL_ARCHIVE}.sha256"
FINAL_MARKER="${FINAL_ARCHIVE}.verified"
[[ ! -e "${FINAL_ARCHIVE}" && ! -e "${FINAL_CHECKSUM}" && ! -e "${FINAL_MARKER}" ]] \
  || die "backup target already exists: ${FINAL_ARCHIVE}"

ARCHIVE_SHA256="$(sha256sum "${CANDIDATE}" | awk '{print $1}')"
[[ "${ARCHIVE_SHA256}" =~ ^[0-9a-f]{64}$ ]] || die "could not calculate archive SHA256"
printf '%s  %s\n' "${ARCHIVE_SHA256}" "$(basename -- "${FINAL_ARCHIVE}")" \
  > "${WORK}/outer.sha256"

# All files are moved within BACKUP_ROOT, so the final archive appears atomically.
mv -- "${CANDIDATE}" "${FINAL_ARCHIVE}"
mv -- "${WORK}/outer.sha256" "${FINAL_CHECKSUM}"
(
  cd -- "${BACKUP_ROOT}"
  sha256sum --check "$(basename -- "${FINAL_CHECKSUM}")" >/dev/null
)
cat > "${WORK}/verified.marker" <<EOF
format=citysafe-backup-v2
archive=$(basename -- "${FINAL_ARCHIVE}")
sha256=${ARCHIVE_SHA256}
verified_at_utc=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
EOF
mv -- "${WORK}/verified.marker" "${FINAL_MARKER}"

if [[ -n "${OFFSITE_RSYNC}" ]]; then
  require_command rsync
  log "copying the verified backup to off-site storage"
  rsync -a --protect-args \
    "${FINAL_ARCHIVE}" "${FINAL_CHECKSUM}" "${FINAL_MARKER}" \
    "${OFFSITE_RSYNC%/}/"
fi

retain_verified_backups() {
  local marker archive_name archive checksum expected actual checksum_hash checksum_archive
  local retention_list="${WORK}/retention-markers.list"
  local retention_failed=0
  find "${BACKUP_ROOT}" -maxdepth 1 -type f -name 'citysafe_*.verified' \
    -mtime "+${KEEP_DAYS}" -print0 > "${retention_list}"
  while IFS= read -r -d '' marker; do
    [[ -f "${marker}" && ! -L "${marker}" ]] || continue
    archive_name="$(sed -n 's/^archive=//p' "${marker}")"
    [[ "${archive_name}" =~ ^citysafe_[0-9]{8}T[0-9]{6}Z_[0-9a-f]{8}\.tar\.gz(\.enc)?$ ]] \
      || {
        log "ERROR: retention skipped malformed verification marker: ${marker}"
        retention_failed=1
        continue
      }
    archive="${BACKUP_ROOT}/${archive_name}"
    checksum="${archive}.sha256"
    [[ -f "${archive}" && ! -L "${archive}" && -f "${checksum}" && ! -L "${checksum}" ]] \
      || {
        log "ERROR: retention skipped incomplete verified set: ${archive_name}"
        retention_failed=1
        continue
      }
    expected="$(sed -n 's/^sha256=//p' "${marker}")"
    actual="$(sha256sum "${archive}" | awk '{print $1}')"
    [[ "${expected}" =~ ^[0-9a-f]{64}$ && "${actual}" == "${expected}" ]] \
      || {
        log "ERROR: retention kept backup with a failed checksum: ${archive_name}"
        retention_failed=1
        continue
      }
    checksum_hash="$(awk 'NR == 1 {print $1}' "${checksum}")"
    checksum_archive="$(awk 'NR == 1 {sub(/^[^[:space:]]+[[:space:]]+\*?/, ""); print}' "${checksum}")"
    [[ "${checksum_hash}" == "${expected}" && "${checksum_archive}" == "${archive_name}" ]] || {
      log "ERROR: retention kept backup with an invalid checksum file: ${archive_name}"
      retention_failed=1
      continue
    }
    log "retention deleting verified backup older than ${KEEP_DAYS} days: ${archive_name}"
    rm -f -- "${archive}" "${checksum}" "${marker}"
  done < "${retention_list}"
  return "${retention_failed}"
}

retain_verified_backups
log "backup complete: ${FINAL_ARCHIVE}"
