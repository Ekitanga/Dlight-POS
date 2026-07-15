BEGIN;

CREATE TABLE IF NOT EXISTS stabilization_delivery_archive (
    archived_delivery_id UUID PRIMARY KEY,
    order_id UUID NOT NULL,
    order_number VARCHAR(100),
    delivery_data JSONB NOT NULL,
    archive_reason TEXT NOT NULL,
    archived_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stabilization_balance_reconciliation (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_type VARCHAR(20) NOT NULL,
    entity_id UUID NOT NULL,
    entity_name TEXT,
    stored_balance NUMERIC(12,2) NOT NULL,
    ledger_balance NUMERIC(12,2) NOT NULL,
    adjustment NUMERIC(12,2) NOT NULL,
    reconciliation_data JSONB,
    reconciled_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TEMP TABLE canonical_deliveries AS
SELECT order_id, id AS keep_id
FROM (
    SELECT
        d.order_id,
        d.id,
        ROW_NUMBER() OVER (
            PARTITION BY d.order_id
            ORDER BY
                CASE d.delivery_status
                    WHEN 'collected_paid' THEN 5
                    WHEN 'delivered' THEN 4
                    WHEN 'in_transit' THEN 3
                    WHEN 'assigned' THEN 2
                    ELSE 1
                END DESC,
                (d.delivered_at IS NOT NULL) DESC,
                d.created_at ASC,
                d.id
        ) AS row_rank
    FROM deliveries d
    JOIN orders o ON o.id = d.order_id
    WHERE o.delivery_type <> 'walk_in'
) ranked
WHERE row_rank = 1;

INSERT INTO stabilization_delivery_archive (
    archived_delivery_id, order_id, order_number, delivery_data, archive_reason
)
SELECT
    d.id,
    d.order_id,
    o.order_number,
    TO_JSONB(d),
    CASE
        WHEN o.delivery_type = 'walk_in' THEN 'Walk-in order must not have a delivery record'
        ELSE 'Duplicate delivery consolidated into canonical record'
    END
FROM deliveries d
JOIN orders o ON o.id = d.order_id
LEFT JOIN canonical_deliveries c ON c.order_id = d.order_id
WHERE o.delivery_type = 'walk_in'
   OR (c.keep_id IS NOT NULL AND d.id <> c.keep_id)
ON CONFLICT (archived_delivery_id) DO NOTHING;

UPDATE rider_earnings re
SET delivery_id = c.keep_id
FROM deliveries d
JOIN canonical_deliveries c ON c.order_id = d.order_id
WHERE re.delivery_id = d.id
  AND d.id <> c.keep_id;

DELETE FROM deliveries d
USING orders o
WHERE d.order_id = o.id
  AND o.delivery_type = 'walk_in';

DELETE FROM deliveries d
USING canonical_deliveries c
WHERE d.order_id = c.order_id
  AND d.id <> c.keep_id;

UPDATE deliveries d
SET
    rider_id = CASE WHEN o.delivery_type = 'rider' THEN o.rider_id ELSE NULL END,
    courier_id = CASE WHEN o.delivery_type = 'courier' THEN o.courier_id ELSE NULL END,
    delivery_fee = o.delivery_income,
    delivery_income = o.delivery_income,
    delivery_cost = o.delivery_cost,
    earned_amount = o.delivery_cost,
    courier_tracking_number = CASE WHEN o.delivery_type = 'courier' THEN o.courier_tracking_number ELSE NULL END,
    courier_payment_type = CASE WHEN o.delivery_type = 'courier' THEN o.courier_payment_type ELSE NULL END
FROM orders o
WHERE d.order_id = o.id;

WITH supplier_ledgers AS (
    SELECT
        s.id,
        s.name,
        s.balance AS stored_balance,
        COALESCE((SELECT SUM(sp.amount) FROM supplier_payables sp WHERE sp.supplier_id = s.id), 0)
          - COALESCE((SELECT SUM(p.amount) FROM supplier_payments p WHERE p.supplier_id = s.id), 0)
          - COALESCE((SELECT SUM(sr.amount) FROM supplier_returns sr WHERE sr.supplier_id = s.id), 0)
          AS ledger_balance,
        JSONB_BUILD_OBJECT(
            'payables', COALESCE((SELECT SUM(sp.amount) FROM supplier_payables sp WHERE sp.supplier_id = s.id), 0),
            'payments', COALESCE((SELECT SUM(p.amount) FROM supplier_payments p WHERE p.supplier_id = s.id), 0),
            'returns', COALESCE((SELECT SUM(sr.amount) FROM supplier_returns sr WHERE sr.supplier_id = s.id), 0)
        ) AS details
    FROM suppliers s
)
INSERT INTO stabilization_balance_reconciliation (
    entity_type, entity_id, entity_name, stored_balance, ledger_balance, adjustment, reconciliation_data
)
SELECT 'supplier', id, name, stored_balance, ledger_balance, ledger_balance - stored_balance, details
FROM supplier_ledgers
WHERE ABS(stored_balance - ledger_balance) > 0.009;

UPDATE suppliers s
SET balance =
    COALESCE((SELECT SUM(sp.amount) FROM supplier_payables sp WHERE sp.supplier_id = s.id), 0)
    - COALESCE((SELECT SUM(p.amount) FROM supplier_payments p WHERE p.supplier_id = s.id), 0)
    - COALESCE((SELECT SUM(sr.amount) FROM supplier_returns sr WHERE sr.supplier_id = s.id), 0),
    updated_at = NOW();

WITH rider_ledgers AS (
    SELECT
        r.id,
        r.name,
        r.balance AS stored_balance,
        COALESCE((SELECT SUM(re.amount) FROM rider_earnings re WHERE re.rider_id = r.id AND re.status <> 'reversed'), 0)
          - COALESCE((SELECT SUM(rp.amount) FROM rider_payments rp WHERE rp.rider_id = r.id), 0)
          AS ledger_balance,
        JSONB_BUILD_OBJECT(
            'earnings', COALESCE((SELECT SUM(re.amount) FROM rider_earnings re WHERE re.rider_id = r.id AND re.status <> 'reversed'), 0),
            'payments', COALESCE((SELECT SUM(rp.amount) FROM rider_payments rp WHERE rp.rider_id = r.id), 0)
        ) AS details
    FROM riders r
)
INSERT INTO stabilization_balance_reconciliation (
    entity_type, entity_id, entity_name, stored_balance, ledger_balance, adjustment, reconciliation_data
)
SELECT 'rider', id, name, stored_balance, ledger_balance, ledger_balance - stored_balance, details
FROM rider_ledgers
WHERE ABS(stored_balance - ledger_balance) > 0.009;

UPDATE riders r
SET balance =
    COALESCE((SELECT SUM(re.amount) FROM rider_earnings re WHERE re.rider_id = r.id AND re.status <> 'reversed'), 0)
    - COALESCE((SELECT SUM(rp.amount) FROM rider_payments rp WHERE rp.rider_id = r.id), 0),
    updated_at = NOW();

COMMIT;
