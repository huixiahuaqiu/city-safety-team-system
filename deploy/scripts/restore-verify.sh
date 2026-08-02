#!/usr/bin/env bash
# Verify a CitySafe backup by restoring it into a disposable Compose project
# and private temporary directories. Production containers and volumes are
# never mounted as restore targets.
#
# Usage:
#   CITYSAFE_ENV_FILE=/etc/citysafe/server.env \
#   BACKUP_ROOT=/srv/citysafe/backups \
#   bash deploy/scripts/restore-verify.sh [archive]
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
DEPLOY_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"
COMPOSE_FILE="${CITYSAFE_COMPOSE_FILE:-${DEPLOY_DIR}/compose.yaml}"
SERVER_OVERRIDE="${CITYSAFE_SERVER_OVERRIDE:-${DEPLOY_DIR}/compose.server.yaml}"
ENV_FILE="${CITYSAFE_ENV_FILE:-/etc/citysafe/server.env}"
BACKUP_ROOT_INPUT="${BACKUP_ROOT:-/srv/citysafe/backups}"
VERIFY_TMP_ROOT_INPUT="${RESTORE_VERIFY_TMP_ROOT:-${TMPDIR:-/tmp}}"
ENCRYPT_KEY_FILE="${BACKUP_ENCRYPT_KEY_FILE:-}"
HEALTH_TIMEOUT="${RESTORE_VERIFY_HEALTH_TIMEOUT_SECONDS:-180}"
MAX_AGE_HOURS="${RESTORE_VERIFY_MAX_AGE_HOURS:-26}"
WEBHOOK="${HEALTH_WEBHOOK_URL:-}"
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

[[ "${EUID}" -eq 0 ]] || die "run restore verification with sudo/root"
require_command docker
require_command sha256sum
require_command tar
require_command flock
require_command stat
require_uint "RESTORE_VERIFY_HEALTH_TIMEOUT_SECONDS" "${HEALTH_TIMEOUT}"
require_uint "RESTORE_VERIFY_MAX_AGE_HOURS" "${MAX_AGE_HOURS}"
require_safe_file "${COMPOSE_FILE}" "base Compose file"
require_safe_file "${SERVER_OVERRIDE}" "server Compose override"
require_safe_file "${ENV_FILE}" "external environment file"

prepare_maintenance_lock
exec 8>"${MAINTENANCE_LOCK_FILE}"
chmod 0600 -- "${MAINTENANCE_LOCK_FILE}"
flock -n 8 || die "another CitySafe deployment, backup, or restore verification is in progress"

mkdir -p -- "${BACKUP_ROOT_INPUT}" "${VERIFY_TMP_ROOT_INPUT}"
BACKUP_ROOT="$(cd -- "${BACKUP_ROOT_INPUT}" && pwd -P)"
VERIFY_TMP_ROOT="$(cd -- "${VERIFY_TMP_ROOT_INPUT}" && pwd -P)"
[[ "${VERIFY_TMP_ROOT}" != "/" ]] || die "RESTORE_VERIFY_TMP_ROOT may not be the filesystem root"
case "${VERIFY_TMP_ROOT}" in
  /var/lib/docker|/var/lib/docker/*)
    die "RESTORE_VERIFY_TMP_ROOT may not be inside Docker's internal storage"
    ;;
esac

# Share the backup-root lock with backup/retention: exclusive writers there,
# shared readers here, so a concurrent prune cannot delete the archive mid-run.
exec 9>"${BACKUP_ROOT}/.backup.lock"
chmod 0600 -- "${BACKUP_ROOT}/.backup.lock" 2>/dev/null || true
flock -s -n 9 || die "another backup or retention job holds ${BACKUP_ROOT}/.backup.lock"

docker compose version >/dev/null

newest_verified_archive() {
  local newest_marker
  newest_marker="$(
    find "${BACKUP_ROOT}" -maxdepth 1 -type f -name 'citysafe_*.verified' \
      -printf '%T@\t%p\n' \
      | LC_ALL=C sort -nr \
      | sed -n '1{s/^[^\t]*\t//;p;}'
  )"
  [[ -n "${newest_marker}" ]] || return 1
  sed -n 's/^archive=//p' "${newest_marker}"
}

ARCHIVE="${1:-}"
if [[ -z "${ARCHIVE}" ]]; then
  ARCHIVE_NAME="$(newest_verified_archive)" \
    || die "no verified backup exists in ${BACKUP_ROOT}"
  [[ "${ARCHIVE_NAME}" =~ ^citysafe_[0-9]{8}T[0-9]{6}Z_[0-9a-f]{8}\.tar\.gz(\.enc)?$ ]] \
    || die "newest verification marker contains an invalid archive name"
  ARCHIVE="${BACKUP_ROOT}/${ARCHIVE_NAME}"
fi

require_safe_file "${ARCHIVE}" "backup archive"
ARCHIVE_DIR="$(cd -- "$(dirname -- "${ARCHIVE}")" && pwd -P)"
ARCHIVE="${ARCHIVE_DIR}/$(basename -- "${ARCHIVE}")"
CHECKSUM="${ARCHIVE}.sha256"
MARKER="${ARCHIVE}.verified"
require_safe_file "${CHECKSUM}" "archive checksum"
require_safe_file "${MARKER}" "archive verification marker"

ARCHIVE_BASENAME="$(basename -- "${ARCHIVE}")"
MARKED_ARCHIVE="$(sed -n 's/^archive=//p' "${MARKER}")"
MARKED_SHA256="$(sed -n 's/^sha256=//p' "${MARKER}")"
[[ "${MARKED_ARCHIVE}" == "${ARCHIVE_BASENAME}" ]] \
  || die "verification marker does not name this archive"
[[ "${MARKED_SHA256}" =~ ^[0-9a-f]{64}$ ]] \
  || die "verification marker has an invalid SHA256"

CHECKSUM_SHA256="$(awk 'NR == 1 {print $1}' "${CHECKSUM}")"
CHECKSUM_ARCHIVE="$(awk 'NR == 1 {sub(/^[^[:space:]]+[[:space:]]+\*?/, ""); print}' "${CHECKSUM}")"
[[ "${CHECKSUM_SHA256}" =~ ^[0-9a-f]{64}$ ]] \
  || die "archive checksum file has an invalid SHA256"
[[ "${CHECKSUM_ARCHIVE}" == "${ARCHIVE_BASENAME}" ]] \
  || die "archive checksum file names an unexpected target"
[[ "${CHECKSUM_SHA256}" == "${MARKED_SHA256}" ]] \
  || die "checksum file and verification marker disagree"
ACTUAL_SHA256="$(sha256sum "${ARCHIVE}" | awk '{print $1}')"
[[ "${ACTUAL_SHA256}" == "${MARKED_SHA256}" ]] \
  || die "archive does not match its verification marker"

AGE_HOURS=$(( ( $(date +%s) - $(stat -c %Y "${ARCHIVE}") ) / 3600 ))
(( AGE_HOURS >= 0 )) || AGE_HOURS=0
AGE_STALE=0
if (( AGE_HOURS > MAX_AGE_HOURS )); then
  log "WARN: verified backup is ${AGE_HOURS} hours old; target is ${MAX_AGE_HOURS} hours"
  AGE_STALE=1
fi

VERIFY_PROJECT="citysafe-restore-verify-$(date -u '+%Y%m%d%H%M%S')-$(printf '%04x%04x' "${RANDOM}" "${RANDOM}")"
[[ "${VERIFY_PROJECT}" =~ ^citysafe-restore-verify-[0-9]{14}-[0-9a-f]{8}$ ]] \
  || die "could not create a safe isolated Compose project name"
WORK="$(mktemp -d "${VERIFY_TMP_ROOT}/citysafe-restore-verify.XXXXXX")"
chmod 700 "${WORK}"

# Optional: when verifying a workstation backup whose MinIO volume was created
# with different root credentials than the server env, overlay SOURCE_MINIO_ROOT_*.
EFFECTIVE_ENV_FILE="${ENV_FILE}"
if [[ -n "${SOURCE_MINIO_ROOT_USER:-}" || -n "${SOURCE_MINIO_ROOT_PASSWORD:-}" ]]; then
  [[ -n "${SOURCE_MINIO_ROOT_USER:-}" && -n "${SOURCE_MINIO_ROOT_PASSWORD:-}" ]] \
    || die "SOURCE_MINIO_ROOT_USER and SOURCE_MINIO_ROOT_PASSWORD must be set together"
  EFFECTIVE_ENV_FILE="${WORK}/verify.env"
  grep -vE '^(MINIO_ROOT_USER|MINIO_ROOT_PASSWORD)=' "${ENV_FILE}" > "${EFFECTIVE_ENV_FILE}"
  printf 'MINIO_ROOT_USER=%s\n' "${SOURCE_MINIO_ROOT_USER}" >> "${EFFECTIVE_ENV_FILE}"
  printf 'MINIO_ROOT_PASSWORD=%s\n' "${SOURCE_MINIO_ROOT_PASSWORD}" >> "${EFFECTIVE_ENV_FILE}"
  chmod 0600 "${EFFECTIVE_ENV_FILE}"
  log "using SOURCE_MINIO_ROOT_* overlay for isolated MinIO authentication"
fi

COMPOSE=(
  docker compose
  --project-name "${VERIFY_PROJECT}"
  --env-file "${EFFECTIVE_ENV_FILE}"
  -f "${COMPOSE_FILE}"
  -f "${SERVER_OVERRIDE}"
)
"${COMPOSE[@]}" config --quiet

ISOLATED_STACK_CREATED=0
VERIFY_DB_VOLUME=""
VERIFY_MINIO_VOLUME=""
RESULT_REPORTED=0
START_SECONDS="$(date +%s)"

report_failure() {
  if [[ -n "${WEBHOOK}" && "${RESULT_REPORTED}" == "0" ]]; then
    RESULT_REPORTED=1
    if ! curl -fsS -X POST -H 'Content-Type: application/json' \
      --data '{"text":"[citysafe] isolated backup restore verification FAILED"}' \
      "${WEBHOOK}" >/dev/null; then
      log "WARN: failure webhook delivery failed"
    fi
  fi
}

cleanup() {
  local rc=$?
  local cleanup_failed=0
  local volume_name volume_project_label
  local volume_list="${WORK}/isolated-volumes.list"
  trap - EXIT HUP INT TERM
  set +e

  if (( ISOLATED_STACK_CREATED == 1 )); then
    case "${VERIFY_PROJECT}" in
      citysafe-restore-verify-*)
        # Do not use `down --volumes`: a future bad Compose override could
        # point at a production volume. Remove only volumes carrying this
        # random verification project's label.
        if ! "${COMPOSE[@]}" down --remove-orphans --timeout 20; then
          cleanup_failed=1
          log "ERROR: could not remove the isolated verification stack"
        fi
        if docker volume ls \
          --filter "label=com.docker.compose.project=${VERIFY_PROJECT}" \
          --format '{{.Name}}' > "${volume_list}"; then
          while IFS= read -r volume_name; do
            [[ -n "${volume_name}" ]] || continue
            if [[ ! "${volume_name}" =~ ^[A-Za-z0-9_.-]+$ ]]; then
              cleanup_failed=1
              log "ERROR: refused to remove an isolated volume with an unsafe name"
              continue
            fi
            volume_project_label="$(
              docker volume inspect \
                --format '{{index .Labels "com.docker.compose.project"}}' \
                "${volume_name}"
            )"
            if [[ "${volume_project_label}" != "${VERIFY_PROJECT}" ]]; then
              cleanup_failed=1
              log "ERROR: refused to remove volume without the exact verification project label"
              continue
            fi
            if ! docker volume rm -- "${volume_name}" >/dev/null; then
              cleanup_failed=1
              log "ERROR: could not remove isolated verification volume: ${volume_name}"
            fi
          done < "${volume_list}"
        else
          cleanup_failed=1
          log "ERROR: could not enumerate isolated verification volumes"
        fi
        ;;
      *)
        cleanup_failed=1
        log "ERROR: refused to clean an unexpected Compose project"
        ;;
    esac
  fi

  if [[ -n "${WORK:-}" && -d "${WORK}" ]]; then
    case "${WORK}" in
      "${VERIFY_TMP_ROOT}"/citysafe-restore-verify.*)
        if ! rm -rf -- "${WORK}"; then
          cleanup_failed=1
          log "ERROR: could not remove isolated restore directory"
        fi
        ;;
      *)
        cleanup_failed=1
        log "ERROR: refused to remove unexpected restore directory: ${WORK}"
        ;;
    esac
  fi

  if (( cleanup_failed == 1 && rc == 0 )); then
    rc=1
  fi
  if (( rc != 0 )); then
    report_failure
  fi
  exit "${rc}"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

TARBALL="${ARCHIVE}"
if [[ "${ARCHIVE}" == *.enc ]]; then
  require_command openssl
  require_safe_file "${ENCRYPT_KEY_FILE}" "backup encryption key"
  TARBALL="${WORK}/decrypted.tar.gz"
  log "decrypting backup inside the private verification directory"
  openssl enc -d -aes-256-cbc -pbkdf2 -md sha256 \
    -pass "file:${ENCRYPT_KEY_FILE}" \
    -in "${ARCHIVE}" \
    -out "${TARBALL}"
fi

safe_tar_list() {
  local tarball="$1"
  local list_file="$2"
  local verbose_file="${list_file}.verbose"
  local entry clean mode_line kind
  tar -tzf "${tarball}" > "${list_file}"
  tar -tvzf "${tarball}" > "${verbose_file}"
  [[ -s "${list_file}" ]] || die "archive contains no entries"
  while IFS= read -r entry; do
    # GNU/BSD tar often emits a lone "./" root entry; that is safe.
    [[ "${entry}" == "." || "${entry}" == "./" ]] && continue
    clean="${entry#./}"
    [[ -n "${clean}" && "${clean}" != /* ]] || die "archive contains an absolute or empty path"
    case "/${clean}/" in
      */../*) die "archive contains a parent-directory traversal path" ;;
    esac
  done < "${list_file}"
  while IFS= read -r mode_line; do
    kind="${mode_line:0:1}"
    case "${kind}" in
      -|d) ;;
      *) die "archive contains a link or special filesystem entry" ;;
    esac
  done < "${verbose_file}"
}

safe_tar_list "${TARBALL}" "${WORK}/outer.list"
TOP_LEVEL="$(
  sed -n '1{s#^\./##;s#/.*##;p;}' "${WORK}/outer.list"
)"
[[ "${TOP_LEVEL}" =~ ^citysafe-backup-[0-9]{8}T[0-9]{6}Z_[0-9a-f]{8}$ ]] \
  || die "backup has an unexpected top-level directory"
if grep -Ev "^(\./)?${TOP_LEVEL}(/|$)" "${WORK}/outer.list" >/dev/null; then
  die "backup contains entries outside its top-level directory"
fi

tar --no-same-owner --no-same-permissions -C "${WORK}" -xzf "${TARBALL}"
PAYLOAD="${WORK}/${TOP_LEVEL}"
require_safe_file "${PAYLOAD}/manifest.json" "backup manifest"
require_safe_file "${PAYLOAD}/SHA256SUMS" "internal checksum manifest"
grep -Eq '"formatVersion"[[:space:]]*:[[:space:]]*2([,[:space:]]|$)' \
  "${PAYLOAD}/manifest.json" || die "unsupported backup format"
grep -Eq '"environmentFileIncluded"[[:space:]]*:[[:space:]]*false' \
  "${PAYLOAD}/manifest.json" || die "backup manifest does not confirm environment-file exclusion"
grep -Eq '"encryptionKeyFileIncluded"[[:space:]]*:[[:space:]]*false' \
  "${PAYLOAD}/manifest.json" || die "backup manifest does not confirm encryption-key exclusion"

EXPECTED_CHECKSUM_PATHS="$(
  printf '%s\n' \
    manifest.json \
    postgres/database.dump \
    volumes/logs.tar.gz \
    volumes/minio.tar.gz \
    volumes/state.tar.gz \
    volumes/uploads.tar.gz
)"
ACTUAL_CHECKSUM_PATHS="$(
  sed -E 's/^[0-9a-fA-F]{64}[[:space:]]+\*?//' "${PAYLOAD}/SHA256SUMS" \
    | LC_ALL=C sort
)"
[[ "${ACTUAL_CHECKSUM_PATHS}" == "${EXPECTED_CHECKSUM_PATHS}" ]] \
  || die "internal checksum manifest contains missing or unexpected paths"
(
  cd -- "${PAYLOAD}"
  sha256sum --check SHA256SUMS >/dev/null
)

for logical_name in minio state uploads logs; do
  volume_archive="${PAYLOAD}/volumes/${logical_name}.tar.gz"
  require_safe_file "${volume_archive}" "${logical_name} volume archive"
  safe_tar_list "${volume_archive}" "${WORK}/${logical_name}.list"
  log "validated ${logical_name} volume archive"
done

require_safe_file "${PAYLOAD}/postgres/database.dump" "PostgreSQL dump"

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
        log "ERROR: isolated ${service} entered state ${status}"
        return 1
      fi
    fi
    sleep 2
  done
  log "ERROR: timed out waiting for isolated ${service}"
  return 1
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
    || die "could not resolve isolated volume for ${destination}"
  printf '%s\n' "${volume}"
}

assert_isolated_container() {
  local cid="$1"
  local actual_project
  actual_project="$(
    docker inspect \
      --format '{{index .Config.Labels "com.docker.compose.project"}}' \
      "${cid}"
  )"
  [[ "${actual_project}" == "${VERIFY_PROJECT}" ]] \
    || die "refused to use a container outside the isolated verification project"
}

assert_isolated_volume() {
  local volume="$1"
  local actual_project
  actual_project="$(
    docker volume inspect \
      --format '{{index .Labels "com.docker.compose.project"}}' \
      "${volume}"
  )"
  [[ "${actual_project}" == "${VERIFY_PROJECT}" ]] \
    || die "refused to restore into a volume outside the isolated verification project"
}

run_isolated_oneshot() {
  local service="$1"
  local cid exit_code
  log "running isolated one-shot service: ${service}"
  "${COMPOSE[@]}" create --no-build "${service}"
  cid="$("${COMPOSE[@]}" ps -aq "${service}")"
  [[ -n "${cid}" ]] || die "could not create isolated ${service} service"
  assert_isolated_container "${cid}"
  if ! docker start --attach "${cid}"; then
    die "isolated ${service} service could not be started"
  fi
  exit_code="$(docker inspect --format '{{.State.ExitCode}}' "${cid}")"
  [[ "${exit_code}" == "0" ]] \
    || die "isolated ${service} service exited with code ${exit_code}"
}

restore_volume_archive() {
  local logical_name="$1"
  local volume="$2"
  assert_isolated_volume "${volume}"
  docker run --rm -i --network none --entrypoint sh \
    --mount "type=volume,src=${volume},dst=/target" \
    "${ARCHIVER_IMAGE}" \
    -ceu 'exec tar -C /target -xzf -' \
    < "${PAYLOAD}/volumes/${logical_name}.tar.gz"
}

log "creating isolated PostgreSQL and MinIO restore targets"
ISOLATED_STACK_CREATED=1
"${COMPOSE[@]}" create --no-build db minio
VERIFY_DB_CID="$("${COMPOSE[@]}" ps -aq db)"
VERIFY_MINIO_CID="$("${COMPOSE[@]}" ps -aq minio)"
[[ -n "${VERIFY_DB_CID}" && -n "${VERIFY_MINIO_CID}" ]] \
  || die "could not create isolated restore containers"
assert_isolated_container "${VERIFY_DB_CID}"
assert_isolated_container "${VERIFY_MINIO_CID}"

VERIFY_MINIO_VOLUME="$(mount_volume_name "${VERIFY_MINIO_CID}" "/data")"
VERIFY_DB_VOLUME="$(mount_volume_name "${VERIFY_DB_CID}" "/var/lib/postgresql/data")"
assert_isolated_volume "${VERIFY_MINIO_VOLUME}"
assert_isolated_volume "${VERIFY_DB_VOLUME}"

ARCHIVER_IMAGE="$(docker inspect --format '{{.Config.Image}}' "${VERIFY_DB_CID}")"
[[ "${ARCHIVER_IMAGE}" =~ ^[A-Za-z0-9._/@:+-]+$ ]] \
  || die "isolated database container uses an unsafe image reference"
restore_volume_archive minio "${VERIFY_MINIO_VOLUME}"

"${COMPOSE[@]}" start db minio
wait_for_service db
wait_for_service minio

log "restoring PostgreSQL into the isolated database"
"${COMPOSE[@]}" exec -T db sh -ceu '
  exec pg_restore \
    --exit-on-error \
    --no-owner \
    --no-privileges \
    --username="${POSTGRES_USER}" \
    --dbname="${POSTGRES_DB}"
' < "${PAYLOAD}/postgres/database.dump"

# A usable disaster recovery must apply the current forward migrations and
# current MinIO application identity to the restored copies before starting
# the current gateway image. This also keeps older backups verifiable after a
# schema or application-credential rotation.
run_isolated_oneshot migrate
run_isolated_oneshot minio-init

"${COMPOSE[@]}" exec -T db sh -ceu '
  required_tables="schema_migrations app_sync app_accounts app_records audit_events"
  for table_name in ${required_tables}; do
    found="$(
      psql \
        --username="${POSTGRES_USER}" \
        --dbname="${POSTGRES_DB}" \
        --tuples-only \
        --no-align \
        --set=ON_ERROR_STOP=1 \
        --command="SELECT to_regclass('\''public.${table_name}'\'') IS NOT NULL"
    )"
    [ "${found}" = "t" ] || {
      echo "missing required restored table: ${table_name}" >&2
      exit 1
    }
  done
  psql \
    --username="${POSTGRES_USER}" \
    --dbname="${POSTGRES_DB}" \
    --set=ON_ERROR_STOP=1 \
    --command="SELECT count(*) AS applied_migrations FROM schema_migrations" \
    >/dev/null
'

log "restoring application volumes and starting an isolated gateway"
"${COMPOSE[@]}" create --no-build gateway
VERIFY_GATEWAY_CID="$("${COMPOSE[@]}" ps -aq gateway)"
[[ -n "${VERIFY_GATEWAY_CID}" ]] || die "could not create isolated gateway"
assert_isolated_container "${VERIFY_GATEWAY_CID}"

VERIFY_STATE_VOLUME="$(mount_volume_name "${VERIFY_GATEWAY_CID}" "/data")"
VERIFY_UPLOADS_VOLUME="$(mount_volume_name "${VERIFY_GATEWAY_CID}" "/data/uploads")"
VERIFY_LOGS_VOLUME="$(mount_volume_name "${VERIFY_GATEWAY_CID}" "/data/logs")"
restore_volume_archive state "${VERIFY_STATE_VOLUME}"
restore_volume_archive uploads "${VERIFY_UPLOADS_VOLUME}"
restore_volume_archive logs "${VERIFY_LOGS_VOLUME}"

"${COMPOSE[@]}" start gateway
wait_for_service gateway

log "checking restored business data through the application runtime"
"${COMPOSE[@]}" exec -T gateway python -c '
import data_store

assert data_store.healthcheck(), "restored database health check failed"
accounts = data_store.load_accounts()
assert accounts, "restored account table is empty"
sync_items = data_store.list_sync_values()
records = data_store.list_records("papers", limit=1)
print(
    "application data check PASS: accounts=%d sync_keys=%d sampled_papers=%d"
    % (len(accounts), len(sync_items), len(records))
)
'

"${COMPOSE[@]}" exec -T gateway python -c '
import os
from minio import Minio

client = Minio(
    os.environ["MINIO_ENDPOINT"],
    access_key=os.environ["MINIO_ACCESS_KEY"],
    secret_key=os.environ["MINIO_SECRET_KEY"],
    secure=False,
)
bucket = os.environ.get("MINIO_BUCKET", "team-shared")
assert client.bucket_exists(bucket), "restored MinIO bucket is missing"
first_object = next(iter(client.list_objects(bucket, recursive=True)), None)
if first_object is not None:
    response = client.get_object(bucket, first_object.object_name, offset=0, length=1)
    try:
        response.read(1)
    finally:
        response.close()
        response.release_conn()
print("MinIO object check PASS: sampled=%d" % (1 if first_object is not None else 0))
'

RTO_SECONDS=$(( $(date +%s) - START_SECONDS ))
if (( AGE_STALE == 1 )); then
  die "restore contents passed, but backup age violates the ${MAX_AGE_HOURS}-hour RPO target"
fi
log "restore verification PASS: archive=${ARCHIVE_BASENAME}, age=${AGE_HOURS}h, elapsed=${RTO_SECONDS}s"
