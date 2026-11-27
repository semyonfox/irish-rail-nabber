-- Small operational projections of the permanent bus observation archive.
-- Migration 016 retires the former bus_stop_updates table after backfill.

-- No production reader searches the raw archives by route or trip. Keep only
-- their identity indexes for deduplication, including on existing installs.
DROP INDEX IF EXISTS bus_stop_observations_route;
DROP INDEX IF EXISTS bus_stop_observations_trip;
DROP INDEX IF EXISTS bus_vehicle_observations_route;
DROP INDEX IF EXISTS bus_vehicle_observations_trip;

CREATE TABLE IF NOT EXISTS bus_stop_live (
    feed_version_id BIGINT NOT NULL REFERENCES transit_feed_versions(id),
    trip_instance_key TEXT NOT NULL,
    stop_key TEXT NOT NULL,
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
    PRIMARY KEY (feed_version_id, trip_instance_key, stop_key)
);

CREATE INDEX IF NOT EXISTS bus_stop_live_stop
    ON bus_stop_live (feed_version_id, stop_id)
    WHERE stop_id IS NOT NULL;

-- The route statistics use the latest non-null delay for each trip and stop.
-- This deliberately excludes the full prediction payload stored in the archive.
CREATE TABLE IF NOT EXISTS bus_delay_samples (
    feed_version_id BIGINT NOT NULL REFERENCES transit_feed_versions(id),
    trip_instance_key TEXT NOT NULL,
    stop_key TEXT NOT NULL,
    route_id TEXT NOT NULL,
    delay_seconds INTEGER NOT NULL,
    last_seen_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (feed_version_id, trip_instance_key, stop_key)
);

-- A backfill can resume after interruption without repeating completed ID
-- ranges. Its target ID is fixed when that run starts.
CREATE TABLE IF NOT EXISTS bus_storage_backfill_progress (
    name TEXT PRIMARY KEY,
    last_id BIGINT NOT NULL,
    target_id BIGINT NOT NULL,
    as_of TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
