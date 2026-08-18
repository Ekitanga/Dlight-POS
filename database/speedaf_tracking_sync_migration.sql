BEGIN;

ALTER TABLE deliveries
    ADD COLUMN IF NOT EXISTS tracking_provider VARCHAR(40),
    ADD COLUMN IF NOT EXISTS tracking_provider_status VARCHAR(80),
    ADD COLUMN IF NOT EXISTS tracking_message TEXT,
    ADD COLUMN IF NOT EXISTS tracking_event_at TIMESTAMP,
    ADD COLUMN IF NOT EXISTS tracking_checked_at TIMESTAMP,
    ADD COLUMN IF NOT EXISTS tracking_sync_error TEXT,
    ADD COLUMN IF NOT EXISTS tracking_auto_updated_at TIMESTAMP;

CREATE TABLE IF NOT EXISTS courier_tracking_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    delivery_id UUID NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    provider VARCHAR(40) NOT NULL,
    tracking_number VARCHAR(100) NOT NULL,
    provider_status VARCHAR(80),
    message TEXT NOT NULL,
    location TEXT,
    event_at TIMESTAMP,
    external_event_key VARCHAR(64) NOT NULL UNIQUE,
    raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    observed_at TIMESTAMP NOT NULL DEFAULT NOW(),
    triggered_transition BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_courier_tracking_events_order_event
    ON courier_tracking_events(order_id, event_at DESC);
CREATE INDEX IF NOT EXISTS idx_courier_tracking_events_tracking
    ON courier_tracking_events(provider, tracking_number);

COMMIT;
