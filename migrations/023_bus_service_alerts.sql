-- NTA GTFS-Realtime alerts for bus, Luas and rail operators. The feed only
-- carries live notices, so this table is the only history.
CREATE TABLE IF NOT EXISTS bus_service_alerts (
    -- hash of header, first start and agencies. text and stop-list edits update in place
    alert_key TEXT PRIMARY KEY,
    -- route and stop ids only make sense against the static feed they came with
    feed_version_id BIGINT NOT NULL REFERENCES transit_feed_versions(id),
    entity_id TEXT,
    header TEXT NOT NULL,
    description TEXT NOT NULL,
    url TEXT,
    cause TEXT,
    effect TEXT,
    severity TEXT,
    category TEXT NOT NULL,
    starts_at TIMESTAMPTZ,
    -- NULL when NTA left the alert open-ended
    ends_at TIMESTAMPTZ,
    active_periods JSONB NOT NULL,
    agency_ids TEXT[] NOT NULL,
    route_ids TEXT[] NOT NULL,
    stop_ids TEXT[] NOT NULL,
    informed_entities JSONB NOT NULL,
    content_hash TEXT NOT NULL,
    revisions INTEGER NOT NULL DEFAULT 1,
    first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bus_service_alerts_seen
    ON bus_service_alerts (last_seen DESC);

CREATE INDEX IF NOT EXISTS idx_bus_service_alerts_routes
    ON bus_service_alerts USING GIN (route_ids);

CREATE INDEX IF NOT EXISTS idx_bus_service_alerts_stops
    ON bus_service_alerts USING GIN (stop_ids);
