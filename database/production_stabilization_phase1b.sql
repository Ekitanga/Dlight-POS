BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS uq_cod_remittance_reference
    ON cod_remittances(reference)
    WHERE reference IS NOT NULL;

ALTER TABLE daily_reconciliations
    ADD COLUMN IF NOT EXISTS expected_mpesa NUMERIC(12,2) DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS uq_daily_reconciliation_business_date
    ON daily_reconciliations(business_date);

ALTER TABLE inventory VALIDATE CONSTRAINT chk_inventory_nonnegative;
ALTER TABLE products VALIDATE CONSTRAINT chk_product_prices_nonnegative;
ALTER TABLE orders VALIDATE CONSTRAINT chk_order_amounts_nonnegative;
ALTER TABLE order_items VALIDATE CONSTRAINT chk_order_item_amounts_nonnegative;
ALTER TABLE deliveries VALIDATE CONSTRAINT chk_delivery_amounts_nonnegative;
ALTER TABLE supplier_payables VALIDATE CONSTRAINT chk_supplier_payable_amounts;
ALTER TABLE supplier_payments VALIDATE CONSTRAINT chk_supplier_payment_positive;
ALTER TABLE supplier_returns VALIDATE CONSTRAINT chk_supplier_return_positive;
ALTER TABLE rider_earnings VALIDATE CONSTRAINT chk_rider_earning_positive;
ALTER TABLE rider_payments VALIDATE CONSTRAINT chk_rider_payment_positive;
ALTER TABLE cod_collections VALIDATE CONSTRAINT chk_cod_amounts;

COMMIT;
