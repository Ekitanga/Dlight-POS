#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILE="deploy/contabo/docker-compose.yml"

docker compose -f "$COMPOSE_FILE" exec -T db psql \
  -U dlight_app \
  -d dlight_pos \
  -v ON_ERROR_STOP=1 \
  -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;"

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

echo "Database migrations completed."
