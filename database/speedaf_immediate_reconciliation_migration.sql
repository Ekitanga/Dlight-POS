BEGIN;

ALTER TABLE speedaf_remittance_batches
  ADD COLUMN IF NOT EXISTS reverted_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS reverted_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS revert_reason TEXT;

ALTER TABLE speedaf_remittance_batches
  DROP CONSTRAINT IF EXISTS speedaf_remittance_batches_status_check;

ALTER TABLE speedaf_remittance_batches
  ADD CONSTRAINT speedaf_remittance_batches_status_check
  CHECK (status IN ('pending_approval', 'approved', 'rejected', 'reverted'));

-- A fully reversed earning is historical evidence, not an active earning.
-- Keeping one active earning per item lets a corrected Speedaf payment qualify
-- the item again without permitting duplicate live commissions.
DROP INDEX IF EXISTS uq_commission_transaction_order_item;
CREATE UNIQUE INDEX uq_commission_transaction_order_item
  ON commission_transactions(order_item_id)
  WHERE transaction_type = 'earned' AND transaction_status <> 'reversed';

COMMIT;
