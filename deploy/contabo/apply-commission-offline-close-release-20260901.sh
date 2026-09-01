#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
COMPOSE_FILE="deploy/contabo/docker-compose.yml"
RELEASE_ID="commission-offline-close-release-20260901"

cd "$APP_DIR"
umask 077

compose() {
  docker compose -f "$COMPOSE_FILE" "$@"
}

if ! compose exec -T db pg_isready -U dlight_app -d dlight_pos >/dev/null; then
  echo "PostgreSQL is not ready. No changes were made."
  exit 1
fi

app_was_running=false
if compose ps --status running --services | grep -qx app; then
  app_was_running=true
  echo "Stopping the application before backup."
  compose stop app
fi

restore_application() {
  if [ "$app_was_running" = true ]; then
    compose start app >/dev/null 2>&1 || true
  fi
}
trap restore_application EXIT

mkdir -p database/backups
BACKUP_NAME="dlight_pos_pre_${RELEASE_ID}_$(date -u +%Y%m%d_%H%M%SZ).dump"
BACKUP_PATH="database/backups/${BACKUP_NAME}"

echo "Creating verified pre-release backup: ${BACKUP_PATH}"
compose exec -T db pg_dump -U dlight_app -d dlight_pos --format=custom > "$BACKUP_PATH"
test -s "$BACKUP_PATH"
compose exec -T db pg_restore --list < "$BACKUP_PATH" >/dev/null

echo "Rebuilding application image..."
compose build app

echo "Restarting application..."
compose up -d app
app_was_running=false
trap - EXIT

echo "Waiting for application health check..."
healthy=false
for _ in $(seq 1 30); do
  if compose exec -T app node -e "fetch('http://127.0.0.1:4000/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))" >/dev/null 2>&1; then
    healthy=true
    break
  fi
  sleep 2
done
if [ "$healthy" != true ]; then
  echo "Application health check failed after deployment."
  exit 1
fi

echo
echo "Release ${RELEASE_ID} deployed successfully."
echo "Verified backup: ${BACKUP_PATH}"
