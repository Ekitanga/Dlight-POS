ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_address TEXT;

UPDATE orders o
SET delivery_address = c.address
FROM customers c
WHERE o.customer_id = c.id
  AND NULLIF(BTRIM(o.delivery_address), '') IS NULL
  AND NULLIF(BTRIM(c.address), '') IS NOT NULL;
