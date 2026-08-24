-- Full clean-start reset.
-- Preserves users, roles, permissions, user assignments, and company settings.
-- A verified pg_dump backup must exist before this script is run.

BEGIN;

TRUNCATE TABLE
    approvals,
    audit_logs,
    journal_lines,
    journal_entries,
    brands,
    categories,
    cod_collections,
    cod_remittances,
    couriers,
    customer_credits,
    customers,
    daily_reconciliations,
    deliveries,
    expenses,
    inventory,
    inventory_movements,
    order_items,
    order_payments,
    order_refunds,
    orders,
    products,
    reservations,
    rider_earnings,
    rider_payments,
    rider_settlements,
    riders,
    stabilization_balance_reconciliation,
    stabilization_delivery_archive,
    supplier_payables,
    supplier_payments,
    supplier_products,
    supplier_returns,
    supplier_settlements,
    suppliers
RESTART IDENTITY CASCADE;

UPDATE accounting_settings
SET enabled = FALSE,
    cutover_date = NULL,
    activated_by = NULL,
    activated_at = NULL,
    updated_at = NOW()
WHERE singleton_key = TRUE;

DELETE FROM users
WHERE LOWER(email) = 'uat.attendant@dlight.test'
   OR LOWER(full_name) LIKE '%frontend uat%';

COMMIT;
