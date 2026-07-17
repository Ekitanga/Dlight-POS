CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(255) NOT NULL,
    phone VARCHAR(50),
    role VARCHAR(50) NOT NULL DEFAULT 'attendant',
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE permissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) UNIQUE NOT NULL,
    description TEXT,
    module VARCHAR(50) NOT NULL,
    action VARCHAR(50) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE user_permissions (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    permission_id UUID NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
    granted_by UUID REFERENCES users(id),
    granted_at TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, permission_id)
);

CREATE TABLE roles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) UNIQUE NOT NULL,
    description TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE role_permissions (
    role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_id UUID NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE user_roles (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    assigned_by UUID REFERENCES users(id),
    assigned_at TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, role_id)
);

CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id),
    action VARCHAR(100) NOT NULL,
    entity_type VARCHAR(50),
    entity_id UUID,
    old_values JSONB,
    new_values JSONB,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    description TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE brands (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    description TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE suppliers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    contact_person VARCHAR(255),
    phone VARCHAR(50),
    email VARCHAR(255),
    address TEXT,
    notes TEXT,
    balance NUMERIC(12,2) NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMP
);

CREATE TABLE products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sku VARCHAR(100) UNIQUE,
    barcode VARCHAR(100),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    category_id UUID REFERENCES categories(id),
    brand_id UUID REFERENCES brands(id),
    cost_price NUMERIC(12,2) NOT NULL DEFAULT 0,
    selling_price NUMERIC(12,2) NOT NULL DEFAULT 0,
    reorder_level INTEGER NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT true,
    is_dropship BOOLEAN NOT NULL DEFAULT false,
    images TEXT[],
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMP
);

CREATE TABLE supplier_products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    supplier_id UUID NOT NULL REFERENCES suppliers(id),
    product_id UUID NOT NULL REFERENCES products(id),
    supplier_cost NUMERIC(12,2) NOT NULL DEFAULT 0,
    selling_price NUMERIC(12,2),
    is_available BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE inventory (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID NOT NULL REFERENCES products(id),
    quantity INTEGER NOT NULL DEFAULT 0,
    reserved_quantity INTEGER NOT NULL DEFAULT 0,
    damaged_quantity INTEGER NOT NULL DEFAULT 0,
    lost_quantity INTEGER NOT NULL DEFAULT 0,
    returned_quantity INTEGER NOT NULL DEFAULT 0,
    last_updated TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE (product_id)
);

CREATE TABLE inventory_movements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID NOT NULL REFERENCES products(id),
    type VARCHAR(30) NOT NULL CHECK (type IN ('stock_in', 'stock_out', 'adjustment', 'damaged', 'lost', 'reserved', 'reservation_release', 'return_sellable', 'return_damaged')),
    quantity INTEGER NOT NULL,
    reference_id UUID,
    reference_type VARCHAR(50),
    notes TEXT,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE customers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(50),
    normalized_phone VARCHAR(20),
    email VARCHAR(255),
    address TEXT,
    credit_limit NUMERIC(12,2) DEFAULT 0,
    balance NUMERIC(12,2) NOT NULL DEFAULT 0,
    notes TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX uq_customers_normalized_phone ON customers(normalized_phone) WHERE normalized_phone IS NOT NULL;

CREATE TABLE customer_credits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES customers(id),
    order_id UUID,
    amount NUMERIC(12,2) NOT NULL,
    type VARCHAR(20) NOT NULL CHECK (type IN ('sale', 'payment', 'adjustment')),
    due_date DATE,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    created_by UUID REFERENCES users(id)
);

CREATE TABLE riders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(50) NOT NULL,
    national_id VARCHAR(50),
    notes TEXT,
    balance NUMERIC(12,2) NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE couriers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    tracking_prefix VARCHAR(20),
    tracking_url_template TEXT,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TYPE order_status AS ENUM (
    'pending', 'confirmed', 'packed', 'dispatched', 'in_transit', 
    'delivered', 'collected_paid', 'returned', 'cancelled'
);

CREATE TYPE payment_status AS ENUM (
    'pending', 'partially_paid', 'paid'
);

CREATE TYPE delivery_type AS ENUM (
    'walk_in', 'rider', 'courier'
);

CREATE TYPE payment_method AS ENUM (
    'cash', 'mpesa', 'bank_transfer', 'credit'
);

CREATE TABLE orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_number VARCHAR(100) UNIQUE NOT NULL,
    customer_id UUID REFERENCES customers(id),
    delivery_type delivery_type NOT NULL,
    delivery_fee NUMERIC(12,2) DEFAULT 0,
    rider_id UUID REFERENCES riders(id),
    courier_id UUID REFERENCES couriers(id),
    courier_tracking_number VARCHAR(100),
    courier_payment_type VARCHAR(20) CHECK (courier_payment_type IN ('prepaid', 'cod')),
    delivery_address TEXT,
    status order_status NOT NULL DEFAULT 'pending',
    payment_status payment_status NOT NULL DEFAULT 'pending',
    subtotal NUMERIC(12,2) NOT NULL DEFAULT 0,
    discount NUMERIC(12,2) DEFAULT 0,
    tax NUMERIC(12,2) DEFAULT 0,
    total_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
    paid_amount NUMERIC(12,2) DEFAULT 0,
    delivery_income NUMERIC(12,2) NOT NULL DEFAULT 0,
    delivery_fee_payment_method VARCHAR(20) CHECK (
        delivery_fee_payment_method IS NULL OR
        delivery_fee_payment_method IN ('cash', 'mpesa', 'bank_transfer', 'pay_on_delivery', 'paid_to_courier')
    ),
    delivery_fee_paid_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
    courier_customer_fee NUMERIC(12,2) NOT NULL DEFAULT 0,
    courier_actual_fee NUMERIC(12,2) NOT NULL DEFAULT 0,
    delivery_cost NUMERIC(12,2) NOT NULL DEFAULT 0,
    notes TEXT,
    created_by UUID REFERENCES users(id),
    confirmed_by UUID REFERENCES users(id),
    cancelled_by UUID REFERENCES users(id),
    cancelled_at TIMESTAMP,
    sale_date DATE NOT NULL DEFAULT CURRENT_DATE,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE order_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id),
    supplier_id UUID REFERENCES suppliers(id),
    quantity INTEGER NOT NULL,
    internal_quantity INTEGER NOT NULL DEFAULT 0,
    supplier_quantity INTEGER NOT NULL DEFAULT 0,
    unit_cost NUMERIC(12,2) NOT NULL DEFAULT 0,
    supplier_cost NUMERIC(12,2) NOT NULL DEFAULT 0,
    unit_price NUMERIC(12,2) NOT NULL DEFAULT 0,
    total_price NUMERIC(12,2) NOT NULL DEFAULT 0,
    fulfillment_type VARCHAR(20) NOT NULL CHECK (fulfillment_type IN ('internal', 'supplier', 'hybrid')),
    fulfillment_status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (fulfillment_status IN ('pending', 'assigned', 'confirmed', 'fulfilled', 'cancelled', 'returned')),
    payable_id UUID
);

CREATE TABLE order_payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES orders(id),
    amount NUMERIC(12,2) NOT NULL,
    payment_method payment_method NOT NULL,
    payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
    reference VARCHAR(255),
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES orders(id),
    rider_id UUID REFERENCES riders(id),
    delivery_status VARCHAR(50) NOT NULL,
    delivery_fee NUMERIC(12,2) NOT NULL DEFAULT 0,
    earned_amount NUMERIC(12,2) DEFAULT 0,
    courier_id UUID REFERENCES couriers(id),
    courier_tracking_number VARCHAR(100),
    courier_payment_type VARCHAR(20) CHECK (courier_payment_type IN ('prepaid', 'cod')),
    delivery_income NUMERIC(12,2) NOT NULL DEFAULT 0,
    delivery_cost NUMERIC(12,2) NOT NULL DEFAULT 0,
    courier_customer_fee NUMERIC(12,2) NOT NULL DEFAULT 0,
    courier_actual_fee NUMERIC(12,2) NOT NULL DEFAULT 0,
    delivered_at TIMESTAMP,
    notes TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE rider_settlements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rider_id UUID NOT NULL REFERENCES riders(id),
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    total_deliveries INTEGER NOT NULL,
    total_earned NUMERIC(12,2) NOT NULL DEFAULT 0,
    settled_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
    balance NUMERIC(12,2) NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'partial', 'paid')),
    settled_at TIMESTAMP,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE rider_earnings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rider_id UUID NOT NULL REFERENCES riders(id),
    delivery_id UUID REFERENCES deliveries(id),
    order_id UUID REFERENCES orders(id),
    amount NUMERIC(12,2) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'payable' CHECK (status IN ('payable', 'paid', 'reversed')),
    notes TEXT,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE rider_payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rider_id UUID NOT NULL REFERENCES riders(id),
    amount NUMERIC(12,2) NOT NULL,
    payment_method payment_method NOT NULL,
    reference VARCHAR(255),
    notes TEXT,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE supplier_settlements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    supplier_id UUID NOT NULL REFERENCES suppliers(id),
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    total_products INTEGER NOT NULL,
    total_cost NUMERIC(12,2) NOT NULL DEFAULT 0,
    settled_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
    balance NUMERIC(12,2) NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'partial', 'paid')),
    settled_at TIMESTAMP,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE supplier_payables (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    supplier_id UUID NOT NULL REFERENCES suppliers(id),
    order_id UUID REFERENCES orders(id),
    order_item_id UUID REFERENCES order_items(id),
    amount NUMERIC(12,2) NOT NULL,
    paid_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'partial', 'paid', 'cancelled', 'returned')),
    description TEXT,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE supplier_payments (
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

CREATE TABLE supplier_returns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    supplier_id UUID NOT NULL REFERENCES suppliers(id),
    payable_id UUID REFERENCES supplier_payables(id),
    order_item_id UUID REFERENCES order_items(id),
    amount NUMERIC(12,2) NOT NULL,
    reason TEXT,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE cod_collections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES orders(id),
    courier_id UUID REFERENCES couriers(id),
    tracking_number VARCHAR(100),
    cod_amount NUMERIC(12,2) NOT NULL,
    remitted_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
    status VARCHAR(40) NOT NULL DEFAULT 'delivered_awaiting_remittance' CHECK (status IN ('assigned_to_courier', 'in_transit', 'delivered_awaiting_remittance', 'partially_remitted', 'remitted', 'closed', 'returned', 'disputed', 'lost')),
    delivered_at TIMESTAMP,
    remitted_at TIMESTAMP,
    closed_at TIMESTAMP,
    due_date DATE,
    notes TEXT,
    created_by UUID REFERENCES users(id),
    closed_by UUID REFERENCES users(id),
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE expenses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    category VARCHAR(100) NOT NULL,
    description TEXT NOT NULL,
    amount NUMERIC(12,2) NOT NULL,
    frequency VARCHAR(20) NOT NULL DEFAULT 'one_off' CHECK (frequency IN ('daily', 'monthly', 'one_off')),
    expense_date DATE NOT NULL,
    effective_end_date DATE,
    payment_method payment_method NOT NULL,
    reference_notes TEXT,
    receipt_url TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    approved_by UUID REFERENCES users(id),
    approved_at TIMESTAMP,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT expenses_effective_end_date_check CHECK (effective_end_date IS NULL OR effective_end_date >= expense_date)
);

CREATE TYPE approval_status AS ENUM ('pending', 'approved', 'rejected');

CREATE TABLE approvals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_type VARCHAR(50) NOT NULL,
    entity_id UUID NOT NULL,
    action VARCHAR(100) NOT NULL,
    old_values JSONB,
    new_values JSONB,
    status approval_status NOT NULL DEFAULT 'pending',
    requested_by UUID NOT NULL REFERENCES users(id),
    approved_by UUID REFERENCES users(id),
    approved_at TIMESTAMP,
    rejection_reason TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE reservations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES customers(id),
    product_id UUID NOT NULL REFERENCES products(id),
    quantity INTEGER NOT NULL,
    reservation_date DATE NOT NULL DEFAULT CURRENT_DATE,
    expiry_date DATE NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'fulfilled', 'expired', 'cancelled')),
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_name VARCHAR(255) NOT NULL,
    logo_url TEXT,
    company_phone VARCHAR(50),
    company_email VARCHAR(255),
    company_address TEXT,
    website VARCHAR(255),
    kra_pin VARCHAR(50),
    receipt_footer TEXT,
    receipt_header VARCHAR(255),
    receipt_paper_width VARCHAR(10) DEFAULT '80mm',
    receipt_show_customer_address BOOLEAN DEFAULT true,
    receipt_show_payment_details BOOLEAN DEFAULT true,
    receipt_show_delivery_details BOOLEAN DEFAULT true,
    currency VARCHAR(10) NOT NULL DEFAULT 'KES',
    tax_rate NUMERIC(5,2) DEFAULT 0,
    mpesa_paybill VARCHAR(20),
    mpesa_account_number VARCHAR(50),
    mpesa_till VARCHAR(20),
    bank_details TEXT,
    order_prefix VARCHAR(20) DEFAULT 'ORD',
    appearance_mode VARCHAR(10) DEFAULT 'light',
    brand_preset VARCHAR(20) DEFAULT 'dlight',
    primary_color VARCHAR(7) DEFAULT '#B08D57',
    accent_color VARCHAR(7) DEFAULT '#D4AF67',
    sidebar_style VARCHAR(10) DEFAULT 'dark',
    interface_density VARCHAR(12) DEFAULT 'comfortable',
    expense_categories JSONB NOT NULL DEFAULT '["Rent","Salaries","Electricity","Internet","Packaging","Fuel","Miscellaneous"]'::jsonb,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE daily_reconciliations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_date DATE NOT NULL,
    cash_sales NUMERIC(12,2) DEFAULT 0,
    actual_cash NUMERIC(12,2) DEFAULT 0,
    cash_variance NUMERIC(12,2) DEFAULT 0,
    mpesa_sales NUMERIC(12,2) DEFAULT 0,
    actual_mpesa NUMERIC(12,2) DEFAULT 0,
    mpesa_variance NUMERIC(12,2) DEFAULT 0,
    bank_transfer_sales NUMERIC(12,2) DEFAULT 0,
    credit_sales NUMERIC(12,2) DEFAULT 0,
    cod_pending NUMERIC(12,2) DEFAULT 0,
    cod_collections NUMERIC(12,2) DEFAULT 0,
    expected_cash NUMERIC(12,2) DEFAULT 0,
    expected_mpesa NUMERIC(12,2) DEFAULT 0,
    expenses NUMERIC(12,2) DEFAULT 0,
    rider_payments_due NUMERIC(12,2) DEFAULT 0,
    rider_payments NUMERIC(12,2) DEFAULT 0,
    supplier_payments_due NUMERIC(12,2) DEFAULT 0,
    supplier_payments NUMERIC(12,2) DEFAULT 0,
    notes TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'closed')),
    approved_by UUID REFERENCES users(id),
    closed_by UUID REFERENCES users(id),
    closed_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX uq_daily_reconciliation_business_date ON daily_reconciliations(business_date);

CREATE TABLE cod_remittances (
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

CREATE UNIQUE INDEX uq_cod_remittance_reference ON cod_remittances(reference) WHERE reference IS NOT NULL;

CREATE TABLE order_refunds (
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

CREATE UNIQUE INDEX uq_pending_order_refund ON order_refunds(order_id) WHERE status = 'pending';
CREATE UNIQUE INDEX uq_deliveries_order ON deliveries(order_id);
CREATE UNIQUE INDEX uq_cod_collections_order ON cod_collections(order_id);
CREATE UNIQUE INDEX uq_supplier_payable_order_item ON supplier_payables(order_item_id) WHERE order_item_id IS NOT NULL;
CREATE UNIQUE INDEX uq_active_rider_earning_delivery ON rider_earnings(delivery_id) WHERE delivery_id IS NOT NULL AND status <> 'reversed';

CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_payment_status ON orders(payment_status);
CREATE INDEX idx_orders_sale_date ON orders(sale_date DESC);
CREATE INDEX idx_orders_created_at ON orders(created_at DESC);
CREATE INDEX idx_products_sku ON products(sku);
CREATE INDEX idx_products_barcode ON products(barcode);
CREATE INDEX idx_suppliers_active ON suppliers(is_active);
CREATE INDEX idx_riders_active ON riders(is_active);
CREATE INDEX idx_inventory_product ON inventory(product_id);
