#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
COMPOSE_FILE="deploy/contabo/docker-compose.yml"
MIGRATIONS=(speedaf_tracking_sync_migration.sql speedaf_bulk_remittance_migration.sql)
RELEASE_ID="speedaf-workflow-release-20260818"

cd "$APP_DIR"
umask 077

compose() { docker compose -f "$COMPOSE_FILE" "$@"; }
db_psql() { compose exec -T db psql -X -U dlight_app -d dlight_pos -v ON_ERROR_STOP=1 "$@"; }

if ! compose exec -T db pg_isready -U dlight_app -d dlight_pos >/dev/null; then
  echo "PostgreSQL is not ready. No changes were made."
  exit 1
fi

app_was_running=false
if compose ps --status running --services | grep -qx app; then
  app_was_running=true
  compose stop app
fi
restore_application() {
  if [ "$app_was_running" = true ]; then compose start app >/dev/null 2>&1 || true; fi
}
trap restore_application EXIT

mkdir -p database/backups
BACKUP_PATH="database/backups/dlight_pos_pre_${RELEASE_ID}_$(date -u +%Y%m%d_%H%M%SZ).dump"
echo "Creating verified backup: ${BACKUP_PATH}"
compose exec -T db pg_dump -U dlight_app -d dlight_pos --format=custom > "$BACKUP_PATH"
test -s "$BACKUP_PATH"
compose exec -T db pg_restore --list < "$BACKUP_PATH" >/dev/null

db_psql -q -c "CREATE TABLE IF NOT EXISTS dlight_schema_migrations (
  migration_name TEXT PRIMARY KEY,
  release_id TEXT NOT NULL,
  checksum_sha256 TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);"

for MIGRATION in "${MIGRATIONS[@]}"; do
  MIGRATION_PATH="database/${MIGRATION}"
  test -f "$MIGRATION_PATH"
  checksum="$(sha256sum "$MIGRATION_PATH" | awk '{print $1}')"
  recorded_checksum="$(db_psql -tAc "SELECT checksum_sha256 FROM dlight_schema_migrations WHERE migration_name='${MIGRATION}'" | tr -d '[:space:]')"
  if [ -n "$recorded_checksum" ]; then
    if [ "$recorded_checksum" != "$checksum" ]; then
      echo "Migration ${MIGRATION} was recorded with a different checksum."
      exit 1
    fi
    echo "Already applied: ${MIGRATION}"
  else
    db_psql -q -f "/migrations/${MIGRATION}"
    db_psql -q -c "INSERT INTO dlight_schema_migrations (migration_name, release_id, checksum_sha256)
      VALUES ('${MIGRATION}', '${RELEASE_ID}', '${checksum}');"
  fi
done

verified="$(db_psql -tAc "SELECT
  to_regclass('public.courier_tracking_events') IS NOT NULL
  AND to_regclass('public.speedaf_remittance_batches') IS NOT NULL
  AND to_regclass('public.speedaf_remittance_allocations') IS NOT NULL
  AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='deliveries' AND column_name='tracking_checked_at')" | tr -d '[:space:]')"
if [ "$verified" != "t" ]; then
  echo "Post-migration verification failed."
  exit 1
fi

echo "Speedaf workflow migrations completed. Verified backup: ${BACKUP_PATH}"
echo "Rebuild the application. Automatic tracking remains optional and disabled without an API key."

restore_application
app_was_running=false
trap - EXIT
