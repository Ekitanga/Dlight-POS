#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
COMPOSE_FILE="deploy/contabo/docker-compose.yml"
RELEASE_ID="trial-balance-release-20260824"
MIGRATION="trial_balance_migration.sql"

cd "$APP_DIR"
umask 077

compose() {
  docker compose -f "$COMPOSE_FILE" "$@"
}

db_psql() {
  compose exec -T db psql -X -U dlight_app -d dlight_pos -v ON_ERROR_STOP=1 "$@"
}

if ! compose exec -T db pg_isready -U dlight_app -d dlight_pos >/dev/null; then
  echo "PostgreSQL is not ready. No changes were made."
  exit 1
fi

if ! db_psql -tAc "SELECT to_regclass('public.users') IS NOT NULL" | grep -qx t; then
  echo "The existing Dlight schema was not found. Use deploy/contabo/apply-migrations.sh for a fresh database."
  exit 1
fi

if [ ! -f "database/${MIGRATION}" ]; then
  echo "Missing migration file: database/${MIGRATION}"
  exit 1
fi

app_was_running=false
if compose ps --status running --services | grep -qx app; then
  app_was_running=true
  echo "Stopping the application before the backup and schema upgrade."
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
if [ ! -s "$BACKUP_PATH" ]; then
  echo "Backup creation failed or produced an empty file."
  exit 1
fi
compose exec -T db pg_restore --list < "$BACKUP_PATH" >/dev/null

db_psql -q -c "
  CREATE TABLE IF NOT EXISTS dlight_schema_migrations (
    migration_name TEXT PRIMARY KEY,
    release_id TEXT NOT NULL,
    checksum_sha256 TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
"

checksum="$(sha256sum "database/${MIGRATION}" | awk '{print $1}')"
recorded_checksum="$(db_psql -tAc "SELECT checksum_sha256 FROM dlight_schema_migrations WHERE migration_name='${MIGRATION}'" | tr -d '[:space:]')"

if [ -n "$recorded_checksum" ]; then
  if [ "$recorded_checksum" != "$checksum" ]; then
    echo "Migration ${MIGRATION} was already recorded with a different checksum."
    exit 1
  fi
  echo "Already applied: ${MIGRATION}"
elif db_psql -tAc "SELECT to_regclass('public.journal_entries') IS NOT NULL" | grep -qx t; then
  echo "Accounting tables exist but ${MIGRATION} is not recorded. Refusing to guess a partially applied state."
  exit 1
else
  echo "Applying: ${MIGRATION}"
  db_psql -q -f "/migrations/${MIGRATION}"
  db_psql -q -c "
    INSERT INTO dlight_schema_migrations (migration_name, release_id, checksum_sha256)
    VALUES ('${MIGRATION}', '${RELEASE_ID}', '${checksum}');
  "
fi

verified="$(db_psql -tAc "SELECT
  to_regclass('public.accounts') IS NOT NULL
  AND to_regclass('public.accounting_settings') IS NOT NULL
  AND to_regclass('public.journal_entries') IS NOT NULL
  AND to_regclass('public.journal_lines') IS NOT NULL
  AND (SELECT COUNT(*) >= 26 FROM accounts)
  AND EXISTS (SELECT 1 FROM accounting_settings WHERE singleton_key=TRUE)
  AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_balanced_journal' AND NOT tgisinternal)
  AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_account_completed_order' AND NOT tgisinternal)
  AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_account_order_refund' AND NOT tgisinternal)
" | tr -d '[:space:]')"
if [ "$verified" != "t" ]; then
  echo "Post-migration accounting verification failed."
  exit 1
fi

echo "Trial-balance schema migration completed and verified."
echo "Verified backup: ${BACKUP_PATH}"

restore_application
app_was_running=false
trap - EXIT

echo "Rebuilding application image..."
compose build app

echo "Restarting application..."
compose up -d app

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
echo "Accounting remains inactive until an admin verifies Cash, M-Pesa, and Bank balances in Reports > Finance > Trial Balance."
