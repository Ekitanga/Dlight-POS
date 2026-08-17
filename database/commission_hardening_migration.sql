-- Hardens installations that already applied commission_tables_migration.sql.
-- Safe to run repeatedly.

ALTER TABLE commission_transactions ALTER COLUMN order_id DROP NOT NULL;
ALTER TABLE commission_transactions ALTER COLUMN order_item_id DROP NOT NULL;
ALTER TABLE commission_transactions ALTER COLUMN product_id DROP NOT NULL;
ALTER TABLE commission_transactions ALTER COLUMN eligible_quantity DROP NOT NULL;
ALTER TABLE commission_transactions ALTER COLUMN rate_per_item DROP NOT NULL;
ALTER TABLE commission_transactions ADD COLUMN IF NOT EXISTS qualified_at TIMESTAMP;
UPDATE commission_transactions
SET qualified_at = qualification_date::timestamp
WHERE qualified_at IS NULL;
ALTER TABLE commission_transactions ALTER COLUMN qualified_at SET DEFAULT NOW();
ALTER TABLE commission_transactions ALTER COLUMN qualified_at SET NOT NULL;

ALTER TABLE commission_payments
  ADD COLUMN IF NOT EXISTS commission_transaction_id UUID REFERENCES commission_transactions(id);

CREATE INDEX IF NOT EXISTS idx_commission_payments_transaction
  ON commission_payments(commission_transaction_id);
CREATE INDEX IF NOT EXISTS idx_commission_transactions_qualified_at
  ON commission_transactions(qualified_at);

-- Reversing an earned amount must not permit a second earning for the same
-- order item. Stop safely if legacy data has duplicates so they can be audited
-- rather than silently choosing which historical ledger entry to discard.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM commission_transactions
    WHERE transaction_type = 'earned'
    GROUP BY order_item_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Commission migration stopped: duplicate earned transactions require review before enforcing one earning per order item';
  END IF;
END $$;

DROP INDEX IF EXISTS uq_commission_transaction_order_item;
CREATE UNIQUE INDEX IF NOT EXISTS uq_commission_transaction_order_item
  ON commission_transactions(order_item_id)
  WHERE transaction_type = 'earned';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commission_transactions_positive_amount') THEN
    ALTER TABLE commission_transactions
      ADD CONSTRAINT commission_transactions_positive_amount CHECK (amount > 0) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commission_rates_positive_rate') THEN
    ALTER TABLE commission_rates
      ADD CONSTRAINT commission_rates_positive_rate CHECK (rate_per_item > 0) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commission_programme_date_order') THEN
    ALTER TABLE commission_programmes
      ADD CONSTRAINT commission_programme_date_order CHECK (effective_to IS NULL OR effective_to >= effective_from) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commission_rate_date_order') THEN
    ALTER TABLE commission_rates
      ADD CONSTRAINT commission_rate_date_order CHECK (effective_to IS NULL OR effective_to >= effective_from) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commission_eligibility_date_order') THEN
    ALTER TABLE commission_eligibility
      ADD CONSTRAINT commission_eligibility_date_order CHECK (effective_to IS NULL OR effective_to >= effective_from) NOT VALID;
  END IF;
END $$;
