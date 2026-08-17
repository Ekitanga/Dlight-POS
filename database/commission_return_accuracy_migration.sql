-- Adds authoritative item-level return evidence for proportional commission
-- reversals. Safe to run once after the commission accuracy migration.

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS returned_quantity INTEGER NOT NULL DEFAULT 0;

UPDATE order_items
SET returned_quantity = quantity
WHERE fulfillment_status = 'returned'
  AND returned_quantity = 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_items_returned_quantity_bounds') THEN
    ALTER TABLE order_items
      ADD CONSTRAINT order_items_returned_quantity_bounds
      CHECK (returned_quantity >= 0 AND returned_quantity <= quantity) NOT VALID;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS order_item_returns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id),
  order_item_id UUID NOT NULL REFERENCES order_items(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  internal_quantity INTEGER NOT NULL DEFAULT 0 CHECK (internal_quantity >= 0),
  supplier_quantity INTEGER NOT NULL DEFAULT 0 CHECK (supplier_quantity >= 0),
  stock_condition VARCHAR(20) CHECK (stock_condition IN ('sellable', 'damaged')),
  reason TEXT NOT NULL,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CHECK (internal_quantity + supplier_quantity = quantity)
);

CREATE INDEX IF NOT EXISTS idx_order_item_returns_item
  ON order_item_returns(order_item_id, created_at DESC);
