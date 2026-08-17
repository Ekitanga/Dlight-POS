-- Simple sales commission policy:
-- * only explicitly eligible sales agents earn;
-- * the order sale date selects the programme/rate;
-- * completion unlocks the earning and selects the accounting month.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS commission_eligible BOOLEAN NOT NULL DEFAULT FALSE;

-- Existing attendants are the installation's sales-agent role. Administrators
-- and owners are never made eligible by this migration.
UPDATE users
SET commission_eligible = TRUE
WHERE role = 'attendant';

UPDATE users
SET commission_eligible = FALSE
WHERE role IN ('admin', 'owner');

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_admin_not_commission_eligible') THEN
    ALTER TABLE users
      ADD CONSTRAINT users_admin_not_commission_eligible
      CHECK (NOT commission_eligible OR role NOT IN ('admin', 'owner')) NOT VALID;
  END IF;
END $$;

ALTER TABLE users
  VALIDATE CONSTRAINT users_admin_not_commission_eligible;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS commission_salesperson_eligible BOOLEAN NOT NULL DEFAULT FALSE;

-- This is a one-time eligibility snapshot for existing orders. Future order
-- creation writes the snapshot directly.
UPDATE orders o
SET commission_salesperson_eligible = u.commission_eligible
FROM users u
WHERE u.id = o.created_by
  AND o.commission_salesperson_eligible IS DISTINCT FROM u.commission_eligible;

ALTER TABLE commission_transactions
  ADD COLUMN IF NOT EXISTS policy_date DATE;

UPDATE commission_transactions ct
SET policy_date = COALESCE(o.sale_date, ct.qualification_date)
FROM orders o
WHERE o.id = ct.order_id
  AND ct.transaction_type = 'earned'
  AND ct.policy_date IS NULL;

CREATE INDEX IF NOT EXISTS idx_commission_transactions_policy_date
  ON commission_transactions(policy_date)
  WHERE policy_date IS NOT NULL;
