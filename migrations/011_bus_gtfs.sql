-- Versioned NTA GTFS reference data, stop-update history, and current vehicles.

CREATE TABLE IF NOT EXISTS transit_feed_versions (
    id BIGSERIAL PRIMARY KEY,
    source TEXT NOT NULL,
    content_sha256 TEXT NOT NULL UNIQUE,
    downloaded_at TIMESTAMPTZ NOT NULL,
    imported_at TIMESTAMPTZ,
    is_active BOOLEAN NOT NULL DEFAULT FALSE
);

-- A source can have a staged feed, but only one imported version may be active.
CREATE UNIQUE INDEX IF NOT EXISTS idx_transit_feed_versions_active_source
    ON transit_feed_versions (source)
    WHERE is_active;

CREATE INDEX IF NOT EXISTS idx_transit_feed_versions_imported
    ON transit_feed_versions (imported_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS bus_agencies (
    feed_version_id BIGINT NOT NULL REFERENCES transit_feed_versions(id) ON DELETE CASCADE,
    agency_id TEXT NOT NULL,
    agency_name TEXT,
    agency_url TEXT,
    agency_timezone TEXT,
    PRIMARY KEY (feed_version_id, agency_id)
);

CREATE TABLE IF NOT EXISTS bus_routes (
    feed_version_id BIGINT NOT NULL REFERENCES transit_feed_versions(id) ON DELETE CASCADE,
    route_id TEXT NOT NULL,
    agency_id TEXT,
    route_short_name TEXT,
    route_long_name TEXT,
    route_type INTEGER,
    route_color TEXT,
    route_text_color TEXT,
    PRIMARY KEY (feed_version_id, route_id),
    FOREIGN KEY (feed_version_id, agency_id)
        REFERENCES bus_agencies(feed_version_id, agency_id)
        DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS bus_stops (
    feed_version_id BIGINT NOT NULL REFERENCES transit_feed_versions(id) ON DELETE CASCADE,
    stop_id TEXT NOT NULL,
    stop_code TEXT,
    stop_name TEXT,
    stop_lat DOUBLE PRECISION,
    stop_lon DOUBLE PRECISION,
    parent_station TEXT,
    PRIMARY KEY (feed_version_id, stop_id)
);

CREATE TABLE IF NOT EXISTS bus_trips (
    feed_version_id BIGINT NOT NULL REFERENCES transit_feed_versions(id) ON DELETE CASCADE,
    trip_id TEXT NOT NULL,
    route_id TEXT NOT NULL,
    service_id TEXT,
    trip_headsign TEXT,
    direction_id INTEGER,
    shape_id TEXT,
    PRIMARY KEY (feed_version_id, trip_id),
    FOREIGN KEY (feed_version_id, route_id)
        REFERENCES bus_routes(feed_version_id, route_id)
        DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS bus_stop_times (
    feed_version_id BIGINT NOT NULL,
    trip_id TEXT NOT NULL,
    stop_sequence INTEGER NOT NULL,
    stop_id TEXT NOT NULL,
    -- GTFS permits service times beyond 24:00, so store seconds since service-day midnight.
    arrival_seconds INTEGER,
    departure_seconds INTEGER,
    PRIMARY KEY (feed_version_id, trip_id, stop_sequence),
    FOREIGN KEY (feed_version_id, trip_id)
        REFERENCES bus_trips(feed_version_id, trip_id)
        ON DELETE CASCADE
        DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (feed_version_id, stop_id)
        REFERENCES bus_stops(feed_version_id, stop_id)
        DEFERRABLE INITIALLY DEFERRED
);

COMMENT ON TABLE bus_stop_times IS
    'Full timetable retained for the active feed only; archived hashes are rehydrated before reactivation';

CREATE INDEX IF NOT EXISTS idx_bus_stops_version_name
    ON bus_stops (feed_version_id, stop_name, stop_id);

CREATE INDEX IF NOT EXISTS idx_bus_stop_times_stop
    ON bus_stop_times (feed_version_id, stop_id, trip_id, stop_sequence);

CREATE INDEX IF NOT EXISTS idx_bus_trips_route
    ON bus_trips (feed_version_id, route_id, trip_id);

-- One row per TripUpdate entity is refreshed on every successful full-feed poll.
-- Stop-level history can stay content-deduplicated while boards still know whether
-- a trip remains present in the current realtime feed.
CREATE TABLE IF NOT EXISTS bus_trip_update_freshness (
    feed_version_id BIGINT NOT NULL REFERENCES transit_feed_versions(id) ON DELETE CASCADE,
    trip_instance_key TEXT NOT NULL,
    last_seen_at TIMESTAMPTZ NOT NULL,
    source_timestamp TIMESTAMPTZ,
    schedule_relationship TEXT NOT NULL DEFAULT 'SCHEDULED',
    PRIMARY KEY (feed_version_id, trip_instance_key)
);

CREATE TABLE IF NOT EXISTS bus_stop_updates (
    id BIGSERIAL PRIMARY KEY,
    feed_version_id BIGINT NOT NULL REFERENCES transit_feed_versions(id) ON DELETE CASCADE,
    trip_instance_key TEXT NOT NULL,
    entity_id TEXT,
    trip_id TEXT,
    route_id TEXT,
    service_date DATE,
    vehicle_id TEXT,
    stop_id TEXT,
    stop_sequence INTEGER,
    schedule_relationship TEXT,
    arrival_time TIMESTAMPTZ,
    departure_time TIMESTAMPTZ,
    arrival_delay_seconds INTEGER,
    departure_delay_seconds INTEGER,
    update_hash TEXT NOT NULL,
    source_timestamp TIMESTAMPTZ,
    fetched_at TIMESTAMPTZ NOT NULL,
    last_seen_at TIMESTAMPTZ NOT NULL,
    UNIQUE (feed_version_id, update_hash),
    FOREIGN KEY (feed_version_id, trip_instance_key)
        REFERENCES bus_trip_update_freshness(feed_version_id, trip_instance_key)
        DEFERRABLE INITIALLY DEFERRED
);

-- Keep this as a regular PostgreSQL table. A fetched_at hypertable would require
-- fetched_at in every unique key and would break restart-safe update_hash deduplication.
COMMENT ON TABLE bus_stop_updates IS
    'Deduplicated GTFS-Realtime stop states, pruned by the daemon after the configured history window';

CREATE INDEX IF NOT EXISTS idx_bus_stop_updates_stop_latest
    ON bus_stop_updates (feed_version_id, stop_id, last_seen_at DESC, id DESC)
    WHERE stop_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bus_stop_updates_recent_delays
    ON bus_stop_updates (last_seen_at DESC, feed_version_id, route_id)
    INCLUDE (trip_id, service_date, stop_id, stop_sequence,
             arrival_delay_seconds, departure_delay_seconds)
    WHERE arrival_delay_seconds IS NOT NULL OR departure_delay_seconds IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bus_stop_updates_trip
    ON bus_stop_updates (feed_version_id, trip_id)
    WHERE trip_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bus_stop_updates_trip_instance_latest
    ON bus_stop_updates
       (feed_version_id, trip_instance_key, last_seen_at DESC, id DESC);

-- VehiclePosition is a current-state feed. Keep one row per vehicle identity and
-- refresh last_seen_at even when its state hash has not changed.
CREATE TABLE IF NOT EXISTS bus_vehicle_positions (
    id BIGSERIAL PRIMARY KEY,
    feed_version_id BIGINT NOT NULL REFERENCES transit_feed_versions(id) ON DELETE CASCADE,
    vehicle_instance_key TEXT NOT NULL,
    entity_id TEXT,
    vehicle_id TEXT,
    vehicle_label TEXT,
    license_plate TEXT,
    trip_instance_key TEXT NOT NULL,
    trip_id TEXT,
    route_id TEXT,
    service_date DATE,
    schedule_relationship TEXT NOT NULL DEFAULT 'SCHEDULED',
    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION,
    bearing DOUBLE PRECISION,
    speed DOUBLE PRECISION,
    current_stop_sequence INTEGER,
    stop_id TEXT,
    current_status TEXT,
    congestion_level TEXT,
    occupancy_status TEXT,
    occupancy_percentage INTEGER,
    update_hash TEXT NOT NULL,
    source_timestamp TIMESTAMPTZ,
    fetched_at TIMESTAMPTZ NOT NULL,
    last_seen_at TIMESTAMPTZ NOT NULL,
    UNIQUE (feed_version_id, vehicle_instance_key)
);

COMMENT ON TABLE bus_vehicle_positions IS
    'Current bus VehiclePositions from the latest successful FULL_DATASET poll';

CREATE INDEX IF NOT EXISTS idx_bus_vehicle_positions_route_latest
    ON bus_vehicle_positions (feed_version_id, route_id, last_seen_at DESC)
    WHERE route_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bus_vehicle_positions_last_seen
    ON bus_vehicle_positions (last_seen_at);

-- These indexes make the daemon's bounded seven-day-by-default maintenance
-- proportional to expired data instead of requiring full-table scans.
CREATE INDEX IF NOT EXISTS idx_bus_stop_updates_retention
    ON bus_stop_updates (last_seen_at);

CREATE INDEX IF NOT EXISTS idx_bus_trip_update_freshness_retention
    ON bus_trip_update_freshness (last_seen_at);
