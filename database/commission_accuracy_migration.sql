-- Historical facts used by commission evaluation and reconciliation.
-- Safe to run repeatedly before enabling the hardened commission module.

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS product_category_id UUID REFERENCES categories(id);

UPDATE order_items oi
SET product_category_id = p.category_id
FROM products p
WHERE p.id = oi.product_id
  AND oi.product_category_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_order_items_product_category
  ON order_items(product_category_id);

CREATE TABLE IF NOT EXISTS commission_reconciliation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date_from DATE NOT NULL,
  date_to DATE NOT NULL,
  mode VARCHAR(20) NOT NULL CHECK (mode IN ('preview', 'apply')),
  reason TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'completed' CHECK (status IN ('running', 'completed', 'failed')),
  total_items_evaluated INTEGER NOT NULL DEFAULT 0,
  commissions_earned INTEGER NOT NULL DEFAULT 0,
  reversals_created INTEGER NOT NULL DEFAULT 0,
  issues_found INTEGER NOT NULL DEFAULT 0,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_commission_reconciliation_runs_created_at
  ON commission_reconciliation_runs(created_at DESC);
