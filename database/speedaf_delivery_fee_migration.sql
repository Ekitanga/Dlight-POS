ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_delivery_fee_payment_method_check;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS courier_customer_fee NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS courier_actual_fee NUMERIC(12,2) NOT NULL DEFAULT 0;

ALTER TABLE deliveries
  ADD COLUMN IF NOT EXISTS courier_customer_fee NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS courier_actual_fee NUMERIC(12,2) NOT NULL DEFAULT 0;

ALTER TABLE orders
  ADD CONSTRAINT orders_delivery_fee_payment_method_check
  CHECK (
    delivery_fee_payment_method IS NULL OR
    delivery_fee_payment_method IN ('cash', 'mpesa', 'bank_transfer', 'pay_on_delivery', 'paid_to_courier')
  );

UPDATE orders
SET
  courier_customer_fee = CASE
    WHEN courier_customer_fee = 0 AND delivery_type = 'courier'
      THEN GREATEST(COALESCE(delivery_fee, 0), COALESCE(delivery_income, 0), COALESCE(delivery_fee_paid_amount, 0))
    ELSE courier_customer_fee
  END,
  courier_actual_fee = CASE
    WHEN courier_actual_fee = 0 AND delivery_type = 'courier'
      THEN COALESCE(delivery_cost, 0)
    ELSE courier_actual_fee
  END
WHERE delivery_type = 'courier';

UPDATE deliveries d
SET
  courier_customer_fee = CASE
    WHEN d.courier_customer_fee = 0 AND d.courier_id IS NOT NULL
      THEN GREATEST(COALESCE(o.courier_customer_fee, 0), COALESCE(d.delivery_fee, 0), COALESCE(d.delivery_income, 0))
    ELSE d.courier_customer_fee
  END,
  courier_actual_fee = CASE
    WHEN d.courier_actual_fee = 0 AND d.courier_id IS NOT NULL
      THEN GREATEST(COALESCE(o.courier_actual_fee, 0), COALESCE(d.earned_amount, 0), COALESCE(d.delivery_cost, 0))
    ELSE d.courier_actual_fee
  END
FROM orders o
WHERE d.order_id = o.id
  AND d.courier_id IS NOT NULL;
