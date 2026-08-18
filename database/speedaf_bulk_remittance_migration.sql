BEGIN;

CREATE TABLE IF NOT EXISTS speedaf_remittance_batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_number VARCHAR(40) NOT NULL UNIQUE,
    payment_date DATE NOT NULL,
    payment_method payment_method NOT NULL CHECK (payment_method IN ('mpesa', 'bank_transfer')),
    net_amount NUMERIC(12,2) NOT NULL CHECK (net_amount > 0),
    gross_amount NUMERIC(12,2) NOT NULL CHECK (gross_amount >= net_amount),
    fee_amount NUMERIC(12,2) NOT NULL CHECK (fee_amount >= 0),
    external_reference VARCHAR(255),
    notes TEXT,
    status VARCHAR(30) NOT NULL DEFAULT 'pending_approval' CHECK (status IN ('pending_approval', 'approved', 'rejected')),
    created_by UUID NOT NULL REFERENCES users(id),
    submitted_at TIMESTAMP NOT NULL DEFAULT NOW(),
    approved_by UUID REFERENCES users(id),
    approved_at TIMESTAMP,
    rejected_by UUID REFERENCES users(id),
    rejected_at TIMESTAMP,
    rejection_reason TEXT,
    fee_expense_id UUID REFERENCES expenses(id),
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS speedaf_remittance_allocations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_id UUID NOT NULL REFERENCES speedaf_remittance_batches(id) ON DELETE CASCADE,
    order_id UUID NOT NULL REFERENCES orders(id),
    cod_collection_id UUID NOT NULL REFERENCES cod_collections(id),
    gross_amount NUMERIC(12,2) NOT NULL CHECK (gross_amount > 0),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE (batch_id, order_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_speedaf_active_batch_order
    ON speedaf_remittance_allocations(order_id) WHERE active;
CREATE INDEX IF NOT EXISTS idx_speedaf_batches_status_date
    ON speedaf_remittance_batches(status, payment_date DESC);

COMMIT;
