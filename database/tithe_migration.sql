-- Tithe tracking (owner/admin only).
--
-- tithe_settings is a single-row table. The module is OFF until an
-- administrator switches it on in Settings.
--   basis: what the rate is applied to each month
--     net_profit   = revenue - cost of goods - supplier costs - delivery costs - approved expenses
--     gross_profit = revenue - cost of goods - supplier costs
--     revenue      = completed sales + shop delivery income
--   A month with a loss contributes zero tithe.
--
-- tithe_payments records what was actually given. Payments are voided, never
-- deleted, so the history stays auditable.

CREATE TABLE IF NOT EXISTS tithe_settings (
    id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    enabled BOOLEAN NOT NULL DEFAULT false,
    rate_percent NUMERIC(5,2) NOT NULL DEFAULT 10 CHECK (rate_percent > 0 AND rate_percent <= 100),
    basis VARCHAR(20) NOT NULL DEFAULT 'net_profit' CHECK (basis IN ('net_profit', 'gross_profit', 'revenue')),
    start_date DATE NOT NULL DEFAULT date_trunc('month', (NOW() AT TIME ZONE 'Africa/Nairobi'))::date,
    recipient_name VARCHAR(255),
    updated_by UUID REFERENCES users(id),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO tithe_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS tithe_payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    paid_on DATE NOT NULL,
    payment_method VARCHAR(20) NOT NULL CHECK (payment_method IN ('cash', 'mpesa', 'bank_transfer', 'other')),
    recipient VARCHAR(255),
    reference VARCHAR(255),
    notes TEXT,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    voided_at TIMESTAMPTZ,
    voided_by UUID REFERENCES users(id),
    void_reason TEXT,
    CHECK ((voided_at IS NULL) = (void_reason IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_tithe_payments_paid_on ON tithe_payments(paid_on) WHERE voided_at IS NULL;
