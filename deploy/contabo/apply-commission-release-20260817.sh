#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
COMPOSE_FILE="deploy/contabo/docker-compose.yml"
RELEASE_ID="commission-release-20260817"

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

MIGRATIONS=(
  commission_module_settings_migration.sql
  commission_tables_migration.sql
  commission_permissions_migration.sql
  commission_hardening_migration.sql
  commission_dashboard_permission_fix.sql
  commission_accuracy_migration.sql
  commission_return_accuracy_migration.sql
  commission_separation_of_duties_migration.sql
  commission_category_snapshot_provenance_migration.sql
  commission_period_closure_migration.sql
  commission_operational_hardening_migration.sql
  commission_business_policy_migration.sql
  commission_initial_activation_fix_migration.sql
)

for migration in "${MIGRATIONS[@]}"; do
  migration_path="database/${migration}"
  if [ ! -f "$migration_path" ]; then
    echo "Missing migration file: ${migration_path}"
    exit 1
  fi

  checksum="$(sha256sum "$migration_path" | awk '{print $1}')"
  recorded_checksum="$(db_psql -tAc "SELECT checksum_sha256 FROM dlight_schema_migrations WHERE migration_name='${migration}'" | tr -d '[:space:]')"
  if [ -n "$recorded_checksum" ]; then
    if [ "$recorded_checksum" != "$checksum" ]; then
      echo "Migration ${migration} was already recorded with a different checksum."
      exit 1
    fi
    echo "Already applied: ${migration}"
    continue
  fi

  if [ "$migration" = "commission_tables_migration.sql" ] && \
     db_psql -tAc "SELECT to_regclass('public.commission_transactions') IS NOT NULL" | grep -qx t; then
    echo "Commission tables exist but ${migration} is not recorded. Refusing to guess a partially applied state."
    exit 1
  fi

  echo "Applying: ${migration}"
  db_psql -q -f "/migrations/${migration}"
  db_psql -q -c "
    INSERT INTO dlight_schema_migrations (migration_name, release_id, checksum_sha256)
    VALUES ('${migration}', '${RELEASE_ID}', '${checksum}');
  "
done

required_tables="$(db_psql -tAc "
  SELECT COUNT(*)
  FROM (VALUES
    (to_regclass('public.commission_programmes')),
    (to_regclass('public.commission_transactions')),
    (to_regclass('public.commission_reconciliation_runs')),
    (to_regclass('public.commission_period_closures'))
  ) AS required(table_name)
  WHERE table_name IS NOT NULL;
" | tr -d '[:space:]')"

eligible_admins="$(db_psql -tAc "SELECT COUNT(*) FROM users WHERE role IN ('admin','owner') AND commission_eligible" | tr -d '[:space:]')"
if [ "$required_tables" != "4" ] || [ "$eligible_admins" != "0" ]; then
  echo "Post-migration verification failed. The application will be restarted with the previous image."
  exit 1
fi

echo "Commission release migrations completed and verified."
echo "Verified backup: ${BACKUP_PATH}"
echo "Next: rebuild the application image, verify /health, configure the 1 August policy, and preview reconciliation before applying it."

restore_application
app_was_running=false
trap - EXIT
