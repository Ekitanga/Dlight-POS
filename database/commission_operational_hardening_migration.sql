-- Operational integrity for independently verified earnings, safe payment
-- retries, and corrections that must retain their original period.

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS commission_completion_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS commission_completion_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS commission_verified_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS commission_verified_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS commission_verification_reason TEXT;

ALTER TABLE commission_transactions
  ADD COLUMN IF NOT EXISTS source_period DATE;

ALTER TABLE commission_payments
  ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(128);

-- A fresh installation starts safely disabled, but has the requested KSh 50
-- global policy ready for management to review and activate. Existing
-- programmes and historical rates are never changed or overwritten.
ALTER TABLE commission_programmes
  ALTER COLUMN status SET DEFAULT 'disabled',
  ALTER COLUMN effective_from SET DEFAULT (NOW() AT TIME ZONE 'Africa/Nairobi');

ALTER TABLE commission_rates
  ALTER COLUMN effective_from SET DEFAULT (NOW() AT TIME ZONE 'Africa/Nairobi');

ALTER TABLE commission_eligibility
  ALTER COLUMN effective_from SET DEFAULT (NOW() AT TIME ZONE 'Africa/Nairobi');

WITH initial_programme AS (
  INSERT INTO commission_programmes (status, effective_from, reason, created_at, updated_at)
  SELECT 'disabled', NOW() AT TIME ZONE 'Africa/Nairobi',
         'Initial KSh 50 commission configuration; activate only after management review.', NOW(), NOW()
  WHERE NOT EXISTS (SELECT 1 FROM commission_programmes)
  RETURNING id
)
INSERT INTO commission_rates
  (programme_id, rate_per_item, effective_from, scope_type, scope_name, created_at)
SELECT id, 50.00, NOW() AT TIME ZONE 'Africa/Nairobi', 'global', 'Initial default rate', NOW()
FROM initial_programme;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commission_payments_positive_paid_amount') THEN
    ALTER TABLE commission_payments
      ADD CONSTRAINT commission_payments_positive_paid_amount
      CHECK (paid_amount > 0) NOT VALID;
  END IF;
END $$;

-- Existing payments remain NULL so historical records are preserved. New
-- disbursement attempts use a stable key, making retries idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS uq_commission_payments_idempotency_key
  ON commission_payments(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_commission_transactions_source_period
  ON commission_transactions(source_period)
  WHERE source_period IS NOT NULL;
