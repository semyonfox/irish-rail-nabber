-- Irish Rail Archive - TimescaleDB Schema
-- PostgreSQL 16 + TimescaleDB

CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;

-- ============================================================================
-- REFERENCE DATA (Static)
-- ============================================================================

CREATE TABLE IF NOT EXISTS stations (
    station_code TEXT PRIMARY KEY,
    station_id TEXT UNIQUE,
    station_desc TEXT NOT NULL,
    station_alias TEXT,
    latitude NUMERIC(8,4),
    longitude NUMERIC(8,4),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stations_desc ON stations(station_desc);

-- ============================================================================
-- TIME-SERIES TABLES (Hypertables for compression)
-- ============================================================================

-- Live train positions (30s snapshots)
CREATE TABLE IF NOT EXISTS train_snapshots (
    id BIGSERIAL,
    train_code TEXT NOT NULL,
    train_status CHAR(1),
    latitude NUMERIC(9,6),
    longitude NUMERIC(9,6),
    train_date DATE,
    direction TEXT,
    public_message TEXT,
    train_type TEXT,
    fetched_at TIMESTAMP NOT NULL,
    PRIMARY KEY (id, fetched_at)
);

SELECT create_hypertable('train_snapshots', 'fetched_at', if_not_exists => TRUE);

ALTER TABLE train_snapshots SET (
    timescaledb.compress,
    timescaledb.compress_orderby = 'fetched_at DESC, train_code',
    timescaledb.compress_chunk_time_interval = '7 days'
);

SELECT add_compression_policy('train_snapshots', INTERVAL '7 days', if_not_exists => TRUE);
SELECT add_retention_policy('train_snapshots', INTERVAL '90 days', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_train_snapshots_code ON train_snapshots(train_code, fetched_at DESC);

-- Station board events (arrivals/departures)
CREATE TABLE IF NOT EXISTS station_events (
    id BIGSERIAL,
    train_code TEXT NOT NULL,
    station_code TEXT REFERENCES stations(station_code),
    scheduled_arrival TIME,
    scheduled_departure TIME,
    actual_arrival TIME,
    actual_departure TIME,
    status TEXT,
    late_minutes INT,
    position_desc TEXT,
    location_type CHAR(1),
    recorded_at TIMESTAMP,
    fetched_at TIMESTAMP NOT NULL,
    PRIMARY KEY (id, fetched_at)
);

SELECT create_hypertable('station_events', 'fetched_at', if_not_exists => TRUE);

ALTER TABLE station_events SET (
    timescaledb.compress,
    timescaledb.compress_orderby = 'fetched_at DESC, train_code, station_code',
    timescaledb.compress_chunk_time_interval = '7 days'
);

SELECT add_compression_policy('station_events', INTERVAL '7 days', if_not_exists => TRUE);
SELECT add_retention_policy('station_events', INTERVAL '90 days', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_station_events_train ON station_events(train_code, fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_station_events_station ON station_events(station_code, fetched_at DESC);

-- Train routes (journey definition)
CREATE TABLE IF NOT EXISTS train_routes (
    id BIGSERIAL PRIMARY KEY,
    train_code TEXT NOT NULL,
    train_date DATE,
    station_code TEXT REFERENCES stations(station_code),
    location_order INT,
    location_type CHAR(1),
    scheduled_arrival TIME,
    scheduled_departure TIME,
    UNIQUE(train_code, train_date, station_code)
);

CREATE INDEX IF NOT EXISTS idx_train_routes_code ON train_routes(train_code, train_date);

-- Fetch metadata
CREATE TABLE IF NOT EXISTS fetch_history (
    id BIGSERIAL PRIMARY KEY,
    endpoint TEXT,
    record_count INT,
    duration_ms INT,
    status TEXT,
    error_msg TEXT,
    fetched_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fetch_history_endpoint ON fetch_history(endpoint, fetched_at DESC);

-- Fetch schedule
CREATE TABLE IF NOT EXISTS fetch_schedules (
    endpoint TEXT PRIMARY KEY,
    interval_seconds INT,
    last_fetched TIMESTAMP,
    next_fetch TIMESTAMP,
    enabled BOOLEAN DEFAULT true,
    updated_at TIMESTAMP DEFAULT NOW()
);

-- ============================================================================
-- INITIALIZATION
-- ============================================================================

INSERT INTO fetch_schedules (endpoint, interval_seconds) VALUES
    ('getAllStationsXML', 86400),
    ('getCurrentTrainsXML', 30),
    ('getStationDataByCodeXML', 30)
ON CONFLICT DO NOTHING;

-- ============================================================================
-- VIEWS FOR EASY QUERYING
-- ============================================================================

CREATE OR REPLACE VIEW latest_train_positions AS
SELECT DISTINCT ON (train_code)
    train_code,
    latitude,
    longitude,
    train_status,
    direction,
    fetched_at
FROM train_snapshots
ORDER BY train_code, fetched_at DESC;

CREATE OR REPLACE VIEW latest_station_events AS
SELECT DISTINCT ON (train_code, station_code)
    train_code,
    station_code,
    status,
    late_minutes,
    actual_arrival,
    actual_departure,
    fetched_at
FROM station_events
ORDER BY train_code, station_code, fetched_at DESC;

-- ============================================================================
-- CONTINUOUS AGGREGATES (For analytics)
-- ============================================================================

CREATE MATERIALIZED VIEW IF NOT EXISTS hourly_delays AS
SELECT
    TIME_BUCKET('1 hour', fetched_at) AS hour,
    station_code,
    AVG(late_minutes)::INT AS avg_late_minutes,
    MAX(late_minutes)::INT AS max_late_minutes,
    COUNT(*) AS event_count
FROM station_events
WHERE late_minutes IS NOT NULL
GROUP BY hour, station_code
WITH DATA;

CREATE INDEX IF NOT EXISTS idx_hourly_delays_hour ON hourly_delays(hour DESC);
CREATE INDEX IF NOT EXISTS idx_hourly_delays_station ON hourly_delays(station_code, hour DESC);

-- Refresh daily
SELECT add_continuous_aggregate_policy('hourly_delays',
    start_offset => INTERVAL '2 hours',
    end_offset => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour',
    if_not_exists => TRUE
);

-- ============================================================================
-- GRANTS (For safety)
-- ============================================================================

GRANT CONNECT ON DATABASE ireland_public TO irish_data;
GRANT USAGE ON SCHEMA public TO irish_data;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO irish_data;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO irish_data;
