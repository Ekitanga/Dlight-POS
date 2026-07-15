ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS sale_date DATE;

UPDATE orders
SET sale_date = created_at::date
WHERE sale_date IS NULL;

ALTER TABLE orders
  ALTER COLUMN sale_date SET DEFAULT CURRENT_DATE,
  ALTER COLUMN sale_date SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_sale_date ON orders(sale_date DESC);
