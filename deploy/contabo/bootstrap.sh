#!/usr/bin/env bash
set -euo pipefail

APP_DOMAIN="${APP_DOMAIN:-169-58-30-49.sslip.io}"
APP_DIR="${APP_DIR:-/opt/dlight-pos}"
REPO_URL="${REPO_URL:-https://github.com/Ekitanga/Dlight-POS.git}"
COMPOSE_FILE="deploy/contabo/docker-compose.yml"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this script as root on the VPS."
  exit 1
fi

echo "Dlight POS Contabo bootstrap"
echo "Domain: ${APP_DOMAIN}"

apt update
DEBIAN_FRONTEND=noninteractive apt upgrade -y
DEBIAN_FRONTEND=noninteractive apt install -y ca-certificates curl gnupg git openssl ufw

if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
  apt update
  DEBIAN_FRONTEND=noninteractive apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

if ! id -u dlight >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" dlight
fi
usermod -aG sudo,docker dlight

ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

if [ -d "${APP_DIR}/.git" ]; then
  git -C "${APP_DIR}" pull
else
  rm -rf "${APP_DIR}"
  git clone "${REPO_URL}" "${APP_DIR}"
fi
chown -R dlight:dlight "${APP_DIR}"

cd "${APP_DIR}"

POSTGRES_PASSWORD="$(openssl rand -base64 36 | tr -d '\n')"
JWT_SECRET="$(openssl rand -hex 48)"
JWT_REFRESH_SECRET="$(openssl rand -hex 48)"

cat > deploy/contabo/.env <<ENV
APP_DOMAIN=${APP_DOMAIN}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
JWT_SECRET=${JWT_SECRET}
JWT_REFRESH_SECRET=${JWT_REFRESH_SECRET}
JWT_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d
ENV

chmod 600 deploy/contabo/.env
chown dlight:dlight deploy/contabo/.env

docker compose -f "${COMPOSE_FILE}" up -d --build

echo "Waiting for PostgreSQL..."
for _ in $(seq 1 60); do
  if docker compose -f "${COMPOSE_FILE}" exec -T db pg_isready -U dlight_app -d dlight_pos >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

if docker compose -f "${COMPOSE_FILE}" exec -T db psql -U dlight_app -d dlight_pos -tAc "SELECT to_regclass('public.users')" | grep -q users; then
  echo "Database schema already exists. Skipping initial migrations."
else
  bash deploy/contabo/apply-migrations.sh
fi

echo
echo "Create first admin account"
read -r -p "Admin email: " ADMIN_EMAIL </dev/tty
read -r -p "Admin full name: " ADMIN_NAME </dev/tty
read -s -r -p "Admin password (min 12 characters): " ADMIN_PASSWORD </dev/tty
echo

docker compose -f "${COMPOSE_FILE}" exec -T \
  -e SEED_ADMIN_EMAIL="${ADMIN_EMAIL}" \
  -e SEED_ADMIN_NAME="${ADMIN_NAME}" \
  -e SEED_ADMIN_PASSWORD="${ADMIN_PASSWORD}" \
  app node packages/backend/dist/seed.js

docker compose -f "${COMPOSE_FILE}" restart app

echo
echo "Deployment complete."
echo "Open: https://${APP_DOMAIN}"
echo "Health: https://${APP_DOMAIN}/health"
echo
echo "Important next step: change the root password now with: passwd root"
