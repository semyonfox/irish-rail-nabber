-- Preserve each observed bus state and trip presence in compressed time-series
-- tables. Migration 016 retires the former regular stop-update table.

CREATE TABLE IF NOT EXISTS bus_stop_observations (
    feed_version_id BIGINT NOT NULL,
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
    trip_schedule_relationship TEXT NOT NULL DEFAULT 'SCHEDULED'
);

SELECT create_hypertable('bus_stop_observations', 'fetched_at',
    chunk_time_interval => INTERVAL '1 hour', if_not_exists => TRUE);

CREATE UNIQUE INDEX IF NOT EXISTS bus_stop_observations_identity
    ON bus_stop_observations (fetched_at, feed_version_id, update_hash);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM timescaledb_information.hypertables
        WHERE hypertable_name = 'bus_stop_observations' AND compression_enabled
    ) THEN
        ALTER TABLE bus_stop_observations SET (
            timescaledb.compress,
            timescaledb.compress_segmentby = 'feed_version_id,route_id',
            timescaledb.compress_orderby = 'fetched_at DESC,trip_instance_key,update_hash'
        );
    END IF;
END $$;
SELECT add_compression_policy('bus_stop_observations', INTERVAL '3 hours',
    schedule_interval => INTERVAL '30 minutes', if_not_exists => TRUE);

CREATE TABLE IF NOT EXISTS bus_vehicle_observations (
    feed_version_id BIGINT NOT NULL,
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
    last_seen_at TIMESTAMPTZ NOT NULL
);

SELECT create_hypertable('bus_vehicle_observations', 'fetched_at',
    chunk_time_interval => INTERVAL '1 hour', if_not_exists => TRUE);

CREATE UNIQUE INDEX IF NOT EXISTS bus_vehicle_observations_identity
    ON bus_vehicle_observations
       (fetched_at, feed_version_id, vehicle_instance_key);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM timescaledb_information.hypertables
        WHERE hypertable_name = 'bus_vehicle_observations' AND compression_enabled
    ) THEN
        ALTER TABLE bus_vehicle_observations SET (
            timescaledb.compress,
            timescaledb.compress_segmentby = 'feed_version_id,route_id',
            timescaledb.compress_orderby = 'fetched_at DESC,vehicle_instance_key'
        );
    END IF;
END $$;
SELECT add_compression_policy('bus_vehicle_observations', INTERVAL '3 hours',
    schedule_interval => INTERVAL '30 minutes', if_not_exists => TRUE);

CREATE TABLE IF NOT EXISTS bus_trip_observations (
    feed_version_id BIGINT NOT NULL,
    trip_instance_key TEXT NOT NULL,
    last_seen_at TIMESTAMPTZ NOT NULL,
    source_timestamp TIMESTAMPTZ,
    schedule_relationship TEXT NOT NULL DEFAULT 'SCHEDULED'
);

SELECT create_hypertable('bus_trip_observations', 'last_seen_at',
    chunk_time_interval => INTERVAL '1 hour', if_not_exists => TRUE);

CREATE UNIQUE INDEX IF NOT EXISTS bus_trip_observations_identity
    ON bus_trip_observations
       (last_seen_at, feed_version_id, trip_instance_key);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM timescaledb_information.hypertables
        WHERE hypertable_name = 'bus_trip_observations' AND compression_enabled
    ) THEN
        ALTER TABLE bus_trip_observations SET (
            timescaledb.compress,
            timescaledb.compress_segmentby = 'feed_version_id',
            timescaledb.compress_orderby = 'last_seen_at DESC,trip_instance_key'
        );
    END IF;
END $$;
SELECT add_compression_policy('bus_trip_observations', INTERVAL '3 hours',
    schedule_interval => INTERVAL '30 minutes', if_not_exists => TRUE);
