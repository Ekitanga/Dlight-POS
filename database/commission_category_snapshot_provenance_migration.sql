-- A category copied from the current product on an old order is not an
-- authoritative historical category snapshot. Mark legacy rows accordingly so
-- reconciliation never silently applies a category-specific rate or rule to
-- them. New order creation explicitly writes a verified snapshot.

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS product_category_snapshot_verified BOOLEAN NOT NULL DEFAULT FALSE;
