-- Automatic import of NEW products from the Dlight website (WooCommerce Store API).
--
-- Rules (agreed with the owner, 2026-11-12):
--   * Existing POS products are never changed: no price, name, cost or stock updates,
--     and nothing is removed when a product disappears from the website.
--   * Clearly new website products are added as supplier-fulfilled, stock 0,
--     cost price 0, website sale price, category Watches or Perfumes.
--   * Colour versions of a watch model the POS already holds as one product are skipped.
--   * Anything uncertain goes to a review list for an owner/admin to Add or Skip.
--
-- website_products remembers every website product ever seen and the decision
-- made for it, so a skipped product never comes back.

CREATE TABLE IF NOT EXISTS website_sync_settings (
    id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    enabled BOOLEAN NOT NULL DEFAULT true,
    source_url TEXT NOT NULL DEFAULT 'https://dlightgiftshop.com',
    run_hour SMALLINT NOT NULL DEFAULT 6 CHECK (run_hour BETWEEN 0 AND 23),
    updated_by UUID REFERENCES users(id),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO website_sync_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS website_products (
    website_product_id BIGINT PRIMARY KEY,
    name TEXT NOT NULL,
    price NUMERIC(12,2),
    category VARCHAR(50),
    permalink TEXT,
    status VARCHAR(30) NOT NULL CHECK (status IN (
        'imported',          -- added to the POS (automatically or by the owner)
        'existing',          -- already in the POS; linked, never changed
        'skipped_variant',   -- colour version of a model held as one POS product
        'skipped',           -- an owner/admin chose not to add it
        'review'             -- waiting for an owner/admin decision
    )),
    reason TEXT,
    product_id UUID REFERENCES products(id),          -- product created from this website item
    matched_product_id UUID REFERENCES products(id),  -- existing POS product it was matched to
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    decided_by UUID REFERENCES users(id),
    decided_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_website_products_status ON website_products(status, first_seen_at DESC);

CREATE TABLE IF NOT EXISTS website_sync_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    trigger VARCHAR(20) NOT NULL CHECK (trigger IN ('scheduled', 'manual')),
    started_by UUID REFERENCES users(id),
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ,
    status VARCHAR(20) NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'failed')),
    fetched INTEGER NOT NULL DEFAULT 0,
    new_seen INTEGER NOT NULL DEFAULT 0,
    added INTEGER NOT NULL DEFAULT 0,
    existing INTEGER NOT NULL DEFAULT 0,
    skipped_variant INTEGER NOT NULL DEFAULT 0,
    review INTEGER NOT NULL DEFAULT 0,
    error TEXT
);
CREATE INDEX IF NOT EXISTS idx_website_sync_runs_started ON website_sync_runs(started_at DESC);
