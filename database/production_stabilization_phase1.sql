BEGIN;

ALTER TABLE customers ADD COLUMN IF NOT EXISTS normalized_phone VARCHAR(20);

UPDATE customers
SET normalized_phone = CASE
    WHEN REGEXP_REPLACE(COALESCE(phone, ''), '[^0-9]', '', 'g') ~ '^0[17][0-9]{8}$'
        THEN '254' || SUBSTRING(REGEXP_REPLACE(phone, '[^0-9]', '', 'g') FROM 2)
    WHEN REGEXP_REPLACE(COALESCE(phone, ''), '[^0-9]', '', 'g') ~ '^[17][0-9]{8}$'
        THEN '254' || REGEXP_REPLACE(phone, '[^0-9]', '', 'g')
    WHEN REGEXP_REPLACE(COALESCE(phone, ''), '[^0-9]', '', 'g') ~ '^254[17][0-9]{8}$'
        THEN REGEXP_REPLACE(phone, '[^0-9]', '', 'g')
    ELSE NULLIF(REGEXP_REPLACE(COALESCE(phone, ''), '[^0-9]', '', 'g'), '')
END;

CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_normalized_phone
    ON customers (normalized_phone)
    WHERE normalized_phone IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_product ON inventory (product_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_deliveries_order ON deliveries (order_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cod_collections_order ON cod_collections (order_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_payable_order_item
    ON supplier_payables (order_item_id)
    WHERE order_item_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_rider_earning_delivery
    ON rider_earnings (delivery_id)
    WHERE delivery_id IS NOT NULL AND status <> 'reversed';

CREATE TABLE IF NOT EXISTS cod_remittances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cod_collection_id UUID NOT NULL REFERENCES cod_collections(id),
    order_id UUID NOT NULL REFERENCES orders(id),
    amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    payment_method payment_method NOT NULL,
    reference VARCHAR(255),
    received_at TIMESTAMP NOT NULL DEFAULT NOW(),
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cod_remittances_received_at ON cod_remittances(received_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cod_remittance_reference
    ON cod_remittances(reference)
    WHERE reference IS NOT NULL;

CREATE TABLE IF NOT EXISTS order_refunds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES orders(id),
    amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'cancelled')),
    payment_method payment_method,
    reference VARCHAR(255),
    reason TEXT,
    refunded_at TIMESTAMP,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_pending_order_refund
    ON order_refunds(order_id)
    WHERE status = 'pending';

ALTER TABLE daily_reconciliations ADD COLUMN IF NOT EXISTS expected_mpesa NUMERIC(12,2) DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS uq_daily_reconciliation_business_date
    ON daily_reconciliations(business_date);

ALTER TABLE inventory
    ADD CONSTRAINT chk_inventory_nonnegative
    CHECK (
        quantity >= 0 AND reserved_quantity >= 0 AND damaged_quantity >= 0
        AND lost_quantity >= 0 AND returned_quantity >= 0
    ) NOT VALID;
ALTER TABLE products
    ADD CONSTRAINT chk_product_prices_nonnegative
    CHECK (cost_price >= 0 AND selling_price >= 0 AND reorder_level >= 0) NOT VALID;
ALTER TABLE orders
    ADD CONSTRAINT chk_order_amounts_nonnegative
    CHECK (
        subtotal >= 0 AND discount >= 0 AND tax >= 0 AND total_amount >= 0
        AND paid_amount >= 0 AND delivery_income >= 0 AND delivery_cost >= 0
    ) NOT VALID;
ALTER TABLE order_items
    ADD CONSTRAINT chk_order_item_amounts_nonnegative
    CHECK (
        quantity > 0 AND internal_quantity >= 0 AND supplier_quantity >= 0
        AND unit_cost >= 0 AND supplier_cost >= 0 AND unit_price >= 0 AND total_price >= 0
    ) NOT VALID;
ALTER TABLE deliveries
    ADD CONSTRAINT chk_delivery_amounts_nonnegative
    CHECK (
        delivery_fee >= 0 AND earned_amount >= 0
        AND delivery_income >= 0 AND delivery_cost >= 0
    ) NOT VALID;
ALTER TABLE supplier_payables
    ADD CONSTRAINT chk_supplier_payable_amounts
    CHECK (amount > 0 AND paid_amount >= 0 AND paid_amount <= amount) NOT VALID;
ALTER TABLE supplier_payments
    ADD CONSTRAINT chk_supplier_payment_positive CHECK (amount > 0) NOT VALID;
ALTER TABLE supplier_returns
    ADD CONSTRAINT chk_supplier_return_positive CHECK (amount > 0) NOT VALID;
ALTER TABLE rider_earnings
    ADD CONSTRAINT chk_rider_earning_positive CHECK (amount > 0) NOT VALID;
ALTER TABLE rider_payments
    ADD CONSTRAINT chk_rider_payment_positive CHECK (amount > 0) NOT VALID;
ALTER TABLE cod_collections
    ADD CONSTRAINT chk_cod_amounts
    CHECK (cod_amount > 0 AND remitted_amount >= 0 AND remitted_amount <= cod_amount) NOT VALID;

COMMIT;
