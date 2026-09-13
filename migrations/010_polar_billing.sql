-- Polar is the merchant of record; Clerk remains the identity provider.
-- Keep this migration idempotent because the daemon runs every migration on startup.

ALTER TABLE users ADD COLUMN IF NOT EXISTS polar_customer_id TEXT UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS polar_subscription_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS polar_state_updated_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS billing_webhook_events (
    provider TEXT NOT NULL,
    event_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (provider, event_id)
);
