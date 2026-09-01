#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILE="deploy/contabo/docker-compose.yml"

docker compose -f "$COMPOSE_FILE" exec -T db psql \
  -U dlight_app \
  -d dlight_pos \
  -v ON_ERROR_STOP=1 \
  -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;"

if docker compose -f "$COMPOSE_FILE" exec -T db psql \
  -U dlight_app -d dlight_pos -tAc "SELECT to_regclass('public.users') IS NOT NULL" | grep -qx t; then
  echo "Refusing to replay the fresh-database migration chain on an existing database."
  echo "Use the release-specific migration script documented for the version being deployed."
  exit 1
fi

docker compose -f "$COMPOSE_FILE" exec -T db psql -U dlight_app -d dlight_pos -v ON_ERROR_STOP=1 -f /migrations/schema.sql
docker compose -f "$COMPOSE_FILE" exec -T db psql -U dlight_app -d dlight_pos -v ON_ERROR_STOP=1 -f /migrations/order_first_migration.sql
docker compose -f "$COMPOSE_FILE" exec -T db psql -U dlight_app -d dlight_pos -v ON_ERROR_STOP=1 -f /migrations/settings_receipt_migration.sql
docker compose -f "$COMPOSE_FILE" exec -T db psql -U dlight_app -d dlight_pos -v ON_ERROR_STOP=1 -f /migrations/status_values_migration.sql
docker compose -f "$COMPOSE_FILE" exec -T db psql -U dlight_app -d dlight_pos -v ON_ERROR_STOP=1 -f /migrations/production_stabilization_phase0.sql
docker compose -f "$COMPOSE_FILE" exec -T db psql -U dlight_app -d dlight_pos -v ON_ERROR_STOP=1 -f /migrations/production_stabilization_phase1.sql
docker compose -f "$COMPOSE_FILE" exec -T db psql -U dlight_app -d dlight_pos -v ON_ERROR_STOP=1 -f /migrations/production_stabilization_phase1b.sql
docker compose -f "$COMPOSE_FILE" exec -T db psql -U dlight_app -d dlight_pos -v ON_ERROR_STOP=1 -f /migrations/permissions_migration.sql
docker compose -f "$COMPOSE_FILE" exec -T db psql -U dlight_app -d dlight_pos -v ON_ERROR_STOP=1 -f /migrations/production_stabilization_permissions.sql
docker compose -f "$COMPOSE_FILE" exec -T db psql -U dlight_app -d dlight_pos -v ON_ERROR_STOP=1 -f /migrations/mpesa_account_settings_migration.sql
docker compose -f "$COMPOSE_FILE" exec -T db psql -U dlight_app -d dlight_pos -v ON_ERROR_STOP=1 -f /migrations/speedaf_delivery_fee_migration.sql
docker compose -f "$COMPOSE_FILE" exec -T db psql -U dlight_app -d dlight_pos -v ON_ERROR_STOP=1 -f /migrations/cod_delivery_fee_split.sql
docker compose -f "$COMPOSE_FILE" exec -T db psql -U dlight_app -d dlight_pos -v ON_ERROR_STOP=1 -f /migrations/order_destination_migration.sql
docker compose -f "$COMPOSE_FILE" exec -T db psql -U dlight_app -d dlight_pos -v ON_ERROR_STOP=1 -f /migrations/expense_workflow_migration.sql
docker compose -f "$COMPOSE_FILE" exec -T db psql -U dlight_app -d dlight_pos -v ON_ERROR_STOP=1 -f /migrations/expense_effective_dates_migration.sql
docker compose -f "$COMPOSE_FILE" exec -T db psql -U dlight_app -d dlight_pos -v ON_ERROR_STOP=1 -f /migrations/customer_fallback_name_migration.sql
docker compose -f "$COMPOSE_FILE" exec -T db psql -U dlight_app -d dlight_pos -v ON_ERROR_STOP=1 -f /migrations/expense_categories_migration.sql
docker compose -f "$COMPOSE_FILE" exec -T db psql -U dlight_app -d dlight_pos -v ON_ERROR_STOP=1 -f /migrations/appearance_settings_migration.sql
docker compose -f "$COMPOSE_FILE" exec -T db psql -U dlight_app -d dlight_pos -v ON_ERROR_STOP=1 -f /migrations/audit_metadata_migration.sql
docker compose -f "$COMPOSE_FILE" exec -T db psql -U dlight_app -d dlight_pos -v ON_ERROR_STOP=1 -f /migrations/business_dates_migration.sql
docker compose -f "$COMPOSE_FILE" exec -T db psql -U dlight_app -d dlight_pos -v ON_ERROR_STOP=1 -f /migrations/order_edit_permission_migration.sql
docker compose -f "$COMPOSE_FILE" exec -T db psql -U dlight_app -d dlight_pos -v ON_ERROR_STOP=1 -f /migrations/commission_module_settings_migration.sql
docker compose -f "$COMPOSE_FILE" exec -T db psql -U dlight_app -d dlight_pos -v ON_ERROR_STOP=1 -f /migrations/commission_tables_migration.sql
docker compose -f "$COMPOSE_FILE" exec -T db psql -U dlight_app -d dlight_pos -v ON_ERROR_STOP=1 -f /migrations/commission_permissions_migration.sql
docker compose -f "$COMPOSE_FILE" exec -T db psql -U dlight_app -d dlight_pos -v ON_ERROR_STOP=1 -f /migrations/commission_hardening_migration.sql
docker compose -f "$COMPOSE_FILE" exec -T db psql -U dlight_app -d dlight_pos -v ON_ERROR_STOP=1 -f /migrations/commission_dashboard_permission_fix.sql
docker compose -f "$COMPOSE_FILE" exec -T db psql -U dlight_app -d dlight_pos -v ON_ERROR_STOP=1 -f /migrations/commission_accuracy_migration.sql
docker compose -f "$COMPOSE_FILE" exec -T db psql -U dlight_app -d dlight_pos -v ON_ERROR_STOP=1 -f /migrations/commission_return_accuracy_migration.sql
docker compose -f "$COMPOSE_FILE" exec -T db psql -U dlight_app -d dlight_pos -v ON_ERROR_STOP=1 -f /migrations/commission_separation_of_duties_migration.sql
docker compose -f "$COMPOSE_FILE" exec -T db psql -U dlight_app -d dlight_pos -v ON_ERROR_STOP=1 -f /migrations/commission_category_snapshot_provenance_migration.sql
docker compose -f "$COMPOSE_FILE" exec -T db psql -U dlight_app -d dlight_pos -v ON_ERROR_STOP=1 -f /migrations/commission_period_closure_migration.sql
docker compose -f "$COMPOSE_FILE" exec -T db psql -U dlight_app -d dlight_pos -v ON_ERROR_STOP=1 -f /migrations/commission_operational_hardening_migration.sql
docker compose -f "$COMPOSE_FILE" exec -T db psql -U dlight_app -d dlight_pos -v ON_ERROR_STOP=1 -f /migrations/commission_business_policy_migration.sql
docker compose -f "$COMPOSE_FILE" exec -T db psql -U dlight_app -d dlight_pos -v ON_ERROR_STOP=1 -f /migrations/commission_month_end_usability_migration.sql

echo "Database migrations completed."
