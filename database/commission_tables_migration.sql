CREATE TABLE commission_programmes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    status VARCHAR(20) NOT NULL DEFAULT 'disabled' CHECK (status IN ('active', 'suspended', 'disabled')),
    effective_from TIMESTAMP NOT NULL DEFAULT (NOW() AT TIME ZONE 'Africa/Nairobi'),
    effective_to TIMESTAMP,
    reason TEXT,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE commission_rates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    programme_id UUID NOT NULL REFERENCES commission_programmes(id),
    rate_per_item NUMERIC(12,2) NOT NULL CHECK (rate_per_item > 0),
    effective_from TIMESTAMP NOT NULL DEFAULT (NOW() AT TIME ZONE 'Africa/Nairobi'),
    effective_to TIMESTAMP,
    scope_type VARCHAR(20) NOT NULL DEFAULT 'global' CHECK (scope_type IN ('global', 'category', 'product', 'salesperson')),
    scope_id UUID,
    scope_name VARCHAR(255),
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE commission_eligibility (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    programme_id UUID NOT NULL REFERENCES commission_programmes(id),
    scope_type VARCHAR(20) NOT NULL CHECK (scope_type IN ('category', 'product')),
    scope_id UUID NOT NULL,
    scope_name VARCHAR(255) NOT NULL,
    is_eligible BOOLEAN NOT NULL DEFAULT true,
    effective_from TIMESTAMP NOT NULL DEFAULT (NOW() AT TIME ZONE 'Africa/Nairobi'),
    effective_to TIMESTAMP,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE commission_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    programme_id UUID NOT NULL REFERENCES commission_programmes(id),
    salesperson_id UUID NOT NULL REFERENCES users(id),
    order_id UUID REFERENCES orders(id),
    order_item_id UUID REFERENCES order_items(id),
    product_id UUID REFERENCES products(id),
    category_id UUID REFERENCES categories(id),
    eligible_quantity INTEGER,
    rate_per_item NUMERIC(12,2),
    amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    transaction_type VARCHAR(20) NOT NULL CHECK (transaction_type IN ('earned', 'reversal', 'manual_add', 'manual_deduct', 'carry_forward', 'payment')),
    transaction_status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (transaction_status IN ('pending', 'approved', 'paid', 'reversed')),
    policy_date DATE,
    qualification_date DATE NOT NULL,
    qualified_at TIMESTAMP NOT NULL DEFAULT NOW(),
    commission_month DATE NOT NULL,
    original_transaction_id UUID REFERENCES commission_transactions(id),
    reference_type VARCHAR(50),
    reference_id UUID,
    source_period DATE,
    reason TEXT,
    approved_by UUID REFERENCES users(id),
    approved_at TIMESTAMP,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE commission_payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    commission_transaction_id UUID REFERENCES commission_transactions(id),
    salesperson_id UUID NOT NULL REFERENCES users(id),
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    total_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
    paid_amount NUMERIC(12,2) NOT NULL CHECK (paid_amount > 0),
    payment_method payment_method NOT NULL,
    reference VARCHAR(255),
    paid_by UUID REFERENCES users(id),
    paid_at TIMESTAMP,
    notes TEXT,
    idempotency_key VARCHAR(128),
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'partial', 'paid')),
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- An order item can earn only once. Reversals are counter-entries, never a
-- license for a retroactive process to create a second earned transaction.
CREATE UNIQUE INDEX uq_commission_transaction_order_item ON commission_transactions(order_item_id) WHERE transaction_type = 'earned';
CREATE INDEX idx_commission_transactions_salesperson ON commission_transactions(salesperson_id);
CREATE INDEX idx_commission_transactions_month ON commission_transactions(commission_month);
CREATE INDEX idx_commission_transactions_order ON commission_transactions(order_id);
CREATE INDEX idx_commission_payments_salesperson ON commission_payments(salesperson_id);
CREATE INDEX idx_commission_payments_period ON commission_payments(period_start, period_end);
CREATE INDEX idx_commission_payments_transaction ON commission_payments(commission_transaction_id);
CREATE INDEX idx_commission_programmes_active_dates ON commission_programmes(status, effective_from, effective_to);
CREATE INDEX idx_commission_rates_programme_dates ON commission_rates(programme_id, effective_from, effective_to);
CREATE INDEX idx_commission_eligibility_programme_lookup ON commission_eligibility(programme_id, scope_type, scope_id, effective_from, effective_to);
