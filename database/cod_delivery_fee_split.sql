BEGIN;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS delivery_fee_payment_method VARCHAR(20),
  ADD COLUMN IF NOT EXISTS delivery_fee_paid_amount NUMERIC(12,2) NOT NULL DEFAULT 0;

ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_delivery_fee_payment_method_check;

ALTER TABLE orders
  ADD CONSTRAINT orders_delivery_fee_payment_method_check
  CHECK (
    delivery_fee_payment_method IS NULL OR
    delivery_fee_payment_method IN ('cash', 'mpesa', 'bank_transfer', 'pay_on_delivery', 'paid_to_courier')
  );

COMMIT;
