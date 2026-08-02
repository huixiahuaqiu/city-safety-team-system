#!/usr/bin/env bash
# First-boot helper for IP + self-signed HTTPS on a fresh Linux host.
# Run as root on the server (or via: ssh citysafe-ecs 'bash -s' < this-file).
set -euo pipefail

DOMAIN="${CITYSAFE_DOMAIN:-47.115.228.246}"
REPO_URL="${CITYSAFE_REPO_URL:-https://github.com/huixiahuaqiu/city-safety-team-system.git}"
REPO_PATH="${CITYSAFE_REPO_PATH:-/opt/city-safety-team-system}"
REPO_REF="${CITYSAFE_REPO_REF:-main}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "ERROR: run as root" >&2
  exit 1
fi

echo "[first-boot] installing git if needed"
if ! command -v git >/dev/null 2>&1; then
  if command -v dnf >/dev/null 2>&1; then
    dnf install -y git
  elif command -v yum >/dev/null 2>&1; then
    yum install -y git
  elif command -v apt-get >/dev/null 2>&1; then
    apt-get update -y
    apt-get install -y git
  else
    echo "ERROR: cannot install git automatically" >&2
    exit 1
  fi
fi

command -v docker >/dev/null 2>&1 || {
  echo "ERROR: docker is not installed" >&2
  exit 1
}
docker compose version >/dev/null

if command -v firewall-cmd >/dev/null 2>&1; then
  echo "[first-boot] opening firewall ports 80/443"
  firewall-cmd --permanent --add-service=http || true
  firewall-cmd --permanent --add-service=https || true
  firewall-cmd --reload || true
elif command -v ufw >/dev/null 2>&1; then
  echo "[first-boot] opening ufw ports 80/443"
  ufw allow 80/tcp || true
  ufw allow 443/tcp || true
fi

if [[ -d "${REPO_PATH}/.git" ]]; then
  echo "[first-boot] updating existing checkout at ${REPO_PATH}"
  git -C "${REPO_PATH}" fetch --prune origin
  git -C "${REPO_PATH}" checkout "${REPO_REF}"
  git -C "${REPO_PATH}" pull --ff-only origin "${REPO_REF}"
else
  echo "[first-boot] cloning ${REPO_URL} -> ${REPO_PATH}"
  install -d -m 0755 "$(dirname "${REPO_PATH}")"
  git clone --branch "${REPO_REF}" "${REPO_URL}" "${REPO_PATH}"
fi

cd "${REPO_PATH}"
echo "[first-boot] running bootstrap --domain ${DOMAIN} --self-signed"
bash deploy/scripts/bootstrap-server.sh --domain "${DOMAIN}" --self-signed
