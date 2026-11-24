-- Irish Rail customer notices from connect.irishrail.ie/realtime/messages.
-- The feed only shows live and upcoming notices, so this table is the only history.
CREATE TABLE IF NOT EXISTS rail_service_alerts (
    -- md5 of head, start and location codes. Body edits update the row in place.
    alert_key TEXT PRIMARY KEY,
    head TEXT NOT NULL,
    body TEXT NOT NULL,
    category TEXT NOT NULL,
    starts_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ NOT NULL,
    location_codes TEXT[] NOT NULL,
    products TEXT[] NOT NULL,
    event_stops JSONB NOT NULL,
    content_hash TEXT NOT NULL,
    revisions INTEGER NOT NULL DEFAULT 1,
    first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- filled once the alert is over and its hourly delay rollups are final
    corridor_codes TEXT[],
    impact_events BIGINT,
    impact_avg_late DOUBLE PRECISION,
    impact_max_late INTEGER,
    baseline_avg_late DOUBLE PRECISION,
    pre_avg_late DOUBLE PRECISION,
    pre_baseline_avg_late DOUBLE PRECISION,
    impact_computed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_rail_service_alerts_window
    ON rail_service_alerts (starts_at DESC, ends_at);

CREATE INDEX IF NOT EXISTS idx_rail_service_alerts_impact_pending
    ON rail_service_alerts (last_seen)
    WHERE impact_computed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_rail_service_alerts_locations
    ON rail_service_alerts USING GIN (location_codes);
