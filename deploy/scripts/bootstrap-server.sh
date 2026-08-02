#!/usr/bin/env bash
# One-time Linux host bootstrap for the containerized CitySafe stack.
# It never imports workstation data or secrets. Re-running preserves existing
# server secrets and only refreshes public domain/release settings.
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${DEPLOY_DIR}/.." && pwd)"

DOMAIN="${CITYSAFE_DOMAIN:-}"
EMAIL=""
ENV_FILE="${CITYSAFE_SERVER_ENV:-/etc/citysafe/server.env}"
TLS_ROOT="${CITYSAFE_TLS_CERT_ROOT:-/etc/letsencrypt}"
PREPARE_ONLY=0
ISSUE_CERT=0
SELF_SIGNED=0
CREATED_ADMIN_PASSWORD=""
MAINTENANCE_LOCK_HELD="${CITYSAFE_MAINTENANCE_LOCK_HELD:-0}"
MAINTENANCE_LOCK_DIR="/run/lock/citysafe"
MAINTENANCE_LOCK_FILE="${MAINTENANCE_LOCK_DIR}/maintenance.lock"

usage() {
  cat <<'EOF'
Usage:
  sudo bash deploy/scripts/bootstrap-server.sh --domain citysafe.example.com [options]
  sudo bash deploy/scripts/bootstrap-server.sh --domain 203.0.113.10 --self-signed

Options:
  --email ADDRESS       Email used by certbot with --issue-cert
  --env-file PATH       Server environment path (default /etc/citysafe/server.env)
  --tls-root PATH       Certificate root (default /etc/letsencrypt)
  --issue-cert          Issue a Let's Encrypt certificate with certbot standalone
  --self-signed         Generate a local self-signed certificate (IP or hostname)
  --prepare-only        Create/check configuration but do not start the stack
  -h, --help            Show this help

Prerequisites:
  Docker Engine with the Compose plugin, OpenSSL, and either an existing
  certificate, certbot when --issue-cert is used, or --self-signed for
  temporary IP/hostname access without a public domain.
EOF
}

while (($#)); do
  case "$1" in
    --domain)
      DOMAIN="${2:-}"
      shift 2
      ;;
    --email)
      EMAIL="${2:-}"
      shift 2
      ;;
    --env-file)
      ENV_FILE="${2:-}"
      shift 2
      ;;
    --tls-root)
      TLS_ROOT="${2:-}"
      shift 2
      ;;
    --issue-cert)
      ISSUE_CERT=1
      shift
      ;;
    --self-signed)
      SELF_SIGNED=1
      shift
      ;;
    --prepare-only)
      PREPARE_ONLY=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "${EUID}" -ne 0 ]]; then
  echo "ERROR: run this one-time bootstrap with sudo/root" >&2
  exit 1
fi
if [[ ! "${DOMAIN}" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]]; then
  echo "ERROR: provide a valid --domain" >&2
  exit 1
fi
if (( ISSUE_CERT == 1 && SELF_SIGNED == 1 )); then
  echo "ERROR: --issue-cert and --self-signed are mutually exclusive" >&2
  exit 1
fi

for command_name in docker openssl sed grep curl flock stat; do
  command -v "${command_name}" >/dev/null 2>&1 || {
    echo "ERROR: required command not found: ${command_name}" >&2
    exit 1
  }
done
docker compose version >/dev/null

if [[ "${MAINTENANCE_LOCK_HELD}" != "1" ]]; then
  if [[ ! -e "${MAINTENANCE_LOCK_DIR}" && ! -L "${MAINTENANCE_LOCK_DIR}" ]]; then
    mkdir -- "${MAINTENANCE_LOCK_DIR}" 2>/dev/null || true
  fi
  if [[ ! -d "${MAINTENANCE_LOCK_DIR}" || -L "${MAINTENANCE_LOCK_DIR}" ]]; then
    echo "ERROR: maintenance lock directory is not a real directory" >&2
    exit 1
  fi
  if [[ "$(stat -c '%u' -- "${MAINTENANCE_LOCK_DIR}")" != "0" ]]; then
    echo "ERROR: maintenance lock directory must be owned by root" >&2
    exit 1
  fi
  chmod 0700 -- "${MAINTENANCE_LOCK_DIR}"
  if [[ -L "${MAINTENANCE_LOCK_FILE}" ]]; then
    echo "ERROR: maintenance lock file may not be a symlink" >&2
    exit 1
  fi
  if [[ -e "${MAINTENANCE_LOCK_FILE}" && ! -f "${MAINTENANCE_LOCK_FILE}" ]]; then
    echo "ERROR: maintenance lock path must be a regular file" >&2
    exit 1
  fi
  exec 9>"${MAINTENANCE_LOCK_FILE}"
  chmod 0600 -- "${MAINTENANCE_LOCK_FILE}"
  flock -n 9 || {
    echo "ERROR: another CitySafe deployment or backup is in progress" >&2
    exit 1
  }
fi

ENV_TEMPLATE="${DEPLOY_DIR}/env/server.example"
BASE_COMPOSE="${DEPLOY_DIR}/compose.yaml"
SERVER_COMPOSE="${DEPLOY_DIR}/compose.server.yaml"

random_hex() {
  openssl rand -hex "${1:-32}"
}

generate_self_signed_cert() {
  local cert_dir="$1"
  local name="$2"
  local san
  install -d -m 0755 "${cert_dir}"
  if [[ "${name}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
    san="IP:${name}"
  else
    san="DNS:${name}"
  fi
  openssl req -x509 -nodes -newkey rsa:2048 \
    -keyout "${cert_dir}/privkey.pem" \
    -out "${cert_dir}/fullchain.pem" \
    -days 825 \
    -subj "/CN=${name}" \
    -addext "subjectAltName=${san}"
  chmod 0644 "${cert_dir}/fullchain.pem"
  chmod 0600 "${cert_dir}/privkey.pem"
  echo "[bootstrap] generated self-signed TLS certificate for ${name}"
}

set_env() {
  local key="$1"
  local value="$2"
  local escaped
  escaped="$(printf '%s' "${value}" | sed 's/[&|]/\\&/g')"
  if grep -q "^${key}=" "${ENV_FILE}"; then
    sed -i "s|^${key}=.*|${key}=${escaped}|" "${ENV_FILE}"
  else
    printf '%s=%s\n' "${key}" "${value}" >> "${ENV_FILE}"
  fi
}

install -d -m 0750 "$(dirname "${ENV_FILE}")"
if [[ ! -f "${ENV_FILE}" ]]; then
  install -m 0600 "${ENV_TEMPLATE}" "${ENV_FILE}"
  set_env POSTGRES_PASSWORD "$(random_hex 32)"
  set_env MINIO_ROOT_PASSWORD "$(random_hex 32)"
  set_env MINIO_SECRET_KEY "$(random_hex 32)"
  set_env AUTH_SIGNING_SECRET "$(random_hex 32)"
  CREATED_ADMIN_PASSWORD="ServerA1!$(random_hex 24)"
  set_env BOOTSTRAP_ADMIN_PASSWORD "${CREATED_ADMIN_PASSWORD}"
  set_env MLOPS_TOKEN "$(random_hex 32)"
  set_env ANNOTATION_UPLOAD_TOKEN "$(random_hex 32)"
  set_env DATASET_UPLOAD_TOKEN "$(random_hex 32)"
  echo "[bootstrap] created server secrets at ${ENV_FILE}"
else
  chmod 0600 "${ENV_FILE}"
  echo "[bootstrap] preserving existing secrets in ${ENV_FILE}"
fi

if ! grep -Eq '^MINIO_ROOT_USER=.+$' "${ENV_FILE}"; then
  set_env MINIO_ROOT_USER citysafe_root
fi
if ! grep -Eq '^MINIO_ROOT_PASSWORD=.+$' "${ENV_FILE}"; then
  set_env MINIO_ROOT_PASSWORD "$(random_hex 32)"
  echo "[bootstrap] added a separate MinIO root credential for this release"
fi

VERSION="${CITYSAFE_IMAGE_TAG:-}"
if [[ -z "${VERSION}" ]]; then
  VERSION="$(git -C "${REPO_ROOT}" rev-parse --short=12 HEAD 2>/dev/null || date -u +%Y%m%d%H%M%S)"
fi

set_env CITYSAFE_IMAGE_TAG "${VERSION}"
set_env SERVER_NAME "${DOMAIN}"
set_env PUBLIC_ORIGIN "https://${DOMAIN}"
set_env CORS_ALLOW_ORIGINS "https://${DOMAIN}"
set_env MINIO_PUBLIC_UPLOAD_PREFIX "https://${DOMAIN}/minio-upload"
set_env TLS_CERT_ROOT "${TLS_ROOT}"

if grep -q 'CHANGE_ME_' "${ENV_FILE}"; then
  echo "ERROR: unresolved CHANGE_ME value remains in ${ENV_FILE}" >&2
  grep -n 'CHANGE_ME_' "${ENV_FILE}" | sed 's/=.*$/=<redacted>/' >&2
  exit 1
fi

CERT_DIR="${TLS_ROOT}/live/${DOMAIN}"
if [[ ! -s "${CERT_DIR}/fullchain.pem" || ! -s "${CERT_DIR}/privkey.pem" ]]; then
  if (( SELF_SIGNED == 1 )); then
    generate_self_signed_cert "${CERT_DIR}" "${DOMAIN}"
  elif (( ISSUE_CERT == 1 )); then
    [[ -n "${EMAIL}" ]] || {
      echo "ERROR: --email is required with --issue-cert" >&2
      exit 1
    }
    command -v certbot >/dev/null 2>&1 || {
      echo "ERROR: certbot is required with --issue-cert" >&2
      exit 1
    }
    certbot certonly --standalone --non-interactive --agree-tos \
      --config-dir "${TLS_ROOT}" \
      --email "${EMAIL}" -d "${DOMAIN}"
  else
    echo "ERROR: TLS certificate not found under ${CERT_DIR}" >&2
    echo "Provide the company certificate there, rerun with --issue-cert --email ADDRESS," >&2
    echo "or use --self-signed for temporary IP/hostname HTTPS." >&2
    exit 1
  fi
fi

compose() {
  docker compose \
    --env-file "${ENV_FILE}" \
    -f "${BASE_COMPOSE}" \
    -f "${SERVER_COMPOSE}" \
    "$@"
}

compose config --quiet
echo "[bootstrap] Compose configuration valid; release=${VERSION}"

if (( PREPARE_ONLY == 1 )); then
  if [[ -n "${CREATED_ADMIN_PASSWORD}" ]]; then
    echo "[bootstrap] initial administrator: admin"
    echo "[bootstrap] initial password: ${CREATED_ADMIN_PASSWORD}"
    echo "[bootstrap] change it immediately after the first login"
  fi
  echo "[bootstrap] prepare-only complete"
  exit 0
fi

compose up -d --build --wait
# Bind-mounted Nginx configuration changes do not alter the Compose service
# hash. Recreate it on every rollout so routing/security changes cannot stay
# stale after a successful application rebuild.
compose up -d --no-deps --force-recreate --wait edge
CURL_EXTRA=()
if (( SELF_SIGNED == 1 )); then
  CURL_EXTRA+=(-k)
fi
curl --fail --silent --show-error --max-time 15 \
  "${CURL_EXTRA[@]}" \
  --resolve "${DOMAIN}:443:127.0.0.1" \
  "https://${DOMAIN}/api/health" >/dev/null

echo "[bootstrap] CitySafe is ready at https://${DOMAIN}"
echo "[bootstrap] DB, MinIO, and gateway have no host-published ports."
if (( SELF_SIGNED == 1 )); then
  echo "[bootstrap] TLS uses a self-signed certificate; browsers will warn until you proceed anyway or install a public certificate."
fi
if [[ -n "${CREATED_ADMIN_PASSWORD}" ]]; then
  echo "[bootstrap] initial administrator: admin"
  echo "[bootstrap] initial password: ${CREATED_ADMIN_PASSWORD}"
  echo "[bootstrap] change it immediately after the first login"
fi
