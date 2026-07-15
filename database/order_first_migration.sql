ALTER TABLE couriers ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE couriers ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW();

ALTER TABLE orders ADD COLUMN IF NOT EXISTS courier_payment_type VARCHAR(20);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_income NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_cost NUMERIC(12,2) NOT NULL DEFAULT 0;

ALTER TABLE order_items ADD COLUMN IF NOT EXISTS internal_quantity INTEGER NOT NULL DEFAULT 0;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS supplier_quantity INTEGER NOT NULL DEFAULT 0;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS supplier_cost NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS fulfillment_status VARCHAR(20) NOT NULL DEFAULT 'pending';
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS payable_id UUID;

ALTER TABLE inventory ADD COLUMN IF NOT EXISTS returned_quantity INTEGER NOT NULL DEFAULT 0;

ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS courier_id UUID REFERENCES couriers(id);
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS courier_tracking_number VARCHAR(100);
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS courier_payment_type VARCHAR(20);
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS delivery_income NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS delivery_cost NUMERIC(12,2) NOT NULL DEFAULT 0;

ALTER TABLE daily_reconciliations ADD COLUMN IF NOT EXISTS actual_cash NUMERIC(12,2) DEFAULT 0;
ALTER TABLE daily_reconciliations ADD COLUMN IF NOT EXISTS cash_variance NUMERIC(12,2) DEFAULT 0;
ALTER TABLE daily_reconciliations ADD COLUMN IF NOT EXISTS actual_mpesa NUMERIC(12,2) DEFAULT 0;
ALTER TABLE daily_reconciliations ADD COLUMN IF NOT EXISTS mpesa_variance NUMERIC(12,2) DEFAULT 0;
ALTER TABLE daily_reconciliations ADD COLUMN IF NOT EXISTS cod_collections NUMERIC(12,2) DEFAULT 0;
ALTER TABLE daily_reconciliations ADD COLUMN IF NOT EXISTS rider_payments NUMERIC(12,2) DEFAULT 0;
ALTER TABLE daily_reconciliations ADD COLUMN IF NOT EXISTS supplier_payments NUMERIC(12,2) DEFAULT 0;
ALTER TABLE daily_reconciliations ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE daily_reconciliations ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES users(id);

CREATE TABLE IF NOT EXISTS supplier_payables (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    supplier_id UUID NOT NULL REFERENCES suppliers(id),
    order_id UUID REFERENCES orders(id),
    order_item_id UUID REFERENCES order_items(id),
    amount NUMERIC(12,2) NOT NULL,
    paid_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'open',
    description TEXT,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS supplier_payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    supplier_id UUID NOT NULL REFERENCES suppliers(id),
    payable_id UUID REFERENCES supplier_payables(id),
    amount NUMERIC(12,2) NOT NULL,
    payment_method payment_method NOT NULL,
    reference VARCHAR(255),
    notes TEXT,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS supplier_returns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    supplier_id UUID NOT NULL REFERENCES suppliers(id),
    payable_id UUID REFERENCES supplier_payables(id),
    order_item_id UUID REFERENCES order_items(id),
    amount NUMERIC(12,2) NOT NULL,
    reason TEXT,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rider_earnings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rider_id UUID NOT NULL REFERENCES riders(id),
    delivery_id UUID REFERENCES deliveries(id),
    order_id UUID REFERENCES orders(id),
    amount NUMERIC(12,2) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'payable',
    notes TEXT,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rider_payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rider_id UUID NOT NULL REFERENCES riders(id),
    amount NUMERIC(12,2) NOT NULL,
    payment_method payment_method NOT NULL,
    reference VARCHAR(255),
    notes TEXT,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cod_collections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES orders(id),
    courier_id UUID REFERENCES couriers(id),
    tracking_number VARCHAR(100),
    cod_amount NUMERIC(12,2) NOT NULL,
    remitted_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
    status VARCHAR(40) NOT NULL DEFAULT 'delivered_awaiting_remittance',
    delivered_at TIMESTAMP,
    remitted_at TIMESTAMP,
    closed_at TIMESTAMP,
    due_date DATE,
    notes TEXT,
    created_by UUID REFERENCES users(id),
    closed_by UUID REFERENCES users(id),
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

INSERT INTO couriers (name, tracking_prefix)
SELECT 'Speedaf', 'SPD'
WHERE NOT EXISTS (SELECT 1 FROM couriers WHERE LOWER(name) = 'speedaf');
