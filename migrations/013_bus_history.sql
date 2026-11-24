-- Route detail boards must not scan the entire national prediction history.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bus_stop_updates_route_latest
    ON bus_stop_updates (feed_version_id, route_id, last_seen_at DESC, id DESC)
    WHERE route_id IS NOT NULL;

-- Append-only observations alongside the small, deduplicated live tables.
-- LIKE copies column types, not the live tables' unique keys or foreign keys.
CREATE TABLE IF NOT EXISTS bus_stop_observations (LIKE bus_stop_updates);
ALTER TABLE bus_stop_observations DROP COLUMN IF EXISTS id;
ALTER TABLE bus_stop_observations ADD COLUMN IF NOT EXISTS trip_schedule_relationship TEXT NOT NULL DEFAULT 'SCHEDULED';
CREATE UNIQUE INDEX IF NOT EXISTS bus_stop_observations_identity
    ON bus_stop_observations (fetched_at, feed_version_id, update_hash);
SELECT create_hypertable('bus_stop_observations', 'fetched_at',
    chunk_time_interval => INTERVAL '1 hour', if_not_exists => TRUE);
ALTER TABLE bus_stop_observations SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'feed_version_id, route_id',
    timescaledb.compress_orderby = 'fetched_at DESC, trip_instance_key, update_hash'
);
SELECT add_compression_policy('bus_stop_observations', INTERVAL '3 hours', schedule_interval => INTERVAL '30 minutes', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS bus_stop_observations_route
    ON bus_stop_observations (feed_version_id, route_id, fetched_at DESC);
CREATE INDEX IF NOT EXISTS bus_stop_observations_trip
    ON bus_stop_observations (feed_version_id, trip_instance_key, fetched_at DESC);

CREATE TABLE IF NOT EXISTS bus_vehicle_observations (LIKE bus_vehicle_positions);
ALTER TABLE bus_vehicle_observations DROP COLUMN IF EXISTS id;
CREATE UNIQUE INDEX IF NOT EXISTS bus_vehicle_observations_identity
    ON bus_vehicle_observations (fetched_at, feed_version_id, vehicle_instance_key);
SELECT create_hypertable('bus_vehicle_observations', 'fetched_at',
    chunk_time_interval => INTERVAL '1 hour', if_not_exists => TRUE);
ALTER TABLE bus_vehicle_observations SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'feed_version_id, route_id',
    timescaledb.compress_orderby = 'fetched_at DESC, vehicle_instance_key'
);
SELECT add_compression_policy('bus_vehicle_observations', INTERVAL '3 hours', schedule_interval => INTERVAL '30 minutes', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS bus_vehicle_observations_route
    ON bus_vehicle_observations (feed_version_id, route_id, fetched_at DESC);
CREATE INDEX IF NOT EXISTS bus_vehicle_observations_trip
    ON bus_vehicle_observations (feed_version_id, trip_instance_key, fetched_at DESC);

-- Preserve cancellations and trips with no stop predictions, too.
CREATE TABLE IF NOT EXISTS bus_trip_observations (LIKE bus_trip_update_freshness);
CREATE UNIQUE INDEX IF NOT EXISTS bus_trip_observations_identity
    ON bus_trip_observations (last_seen_at, feed_version_id, trip_instance_key);
SELECT create_hypertable('bus_trip_observations', 'last_seen_at',
    chunk_time_interval => INTERVAL '1 hour', if_not_exists => TRUE);
ALTER TABLE bus_trip_observations SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'feed_version_id',
    timescaledb.compress_orderby = 'last_seen_at DESC, trip_instance_key'
);
SELECT add_compression_policy('bus_trip_observations', INTERVAL '3 hours', schedule_interval => INTERVAL '30 minutes', if_not_exists => TRUE);

-- Compute each poll's route totals once at ingestion. The current-hour dashboard
-- then scans hundreds of route totals rather than millions of stop observations.
CREATE TABLE IF NOT EXISTS bus_route_poll_stats (
    fetched_at TIMESTAMPTZ NOT NULL,
    feed_version_id BIGINT NOT NULL,
    route_id TEXT NOT NULL,
    sample_count BIGINT NOT NULL,
    delay_sum BIGINT NOT NULL,
    max_delay_seconds INTEGER NOT NULL,
    on_time_count BIGINT NOT NULL,
    early_count BIGINT NOT NULL,
    late_count BIGINT NOT NULL,
    PRIMARY KEY (fetched_at, feed_version_id, route_id)
);
SELECT create_hypertable('bus_route_poll_stats', 'fetched_at',
    chunk_time_interval => INTERVAL '1 day', if_not_exists => TRUE);
ALTER TABLE bus_route_poll_stats SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'feed_version_id, route_id',
    timescaledb.compress_orderby = 'fetched_at DESC'
);
SELECT add_compression_policy('bus_route_poll_stats', INTERVAL '7 days', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS bus_route_poll_stats_route
    ON bus_route_poll_stats (feed_version_id, route_id, fetched_at DESC);

-- Observation-weighted predictions, not unique journeys or actual arrivals.
-- The unmaterialized tail is included so newly collected data is visible immediately.
CREATE MATERIALIZED VIEW IF NOT EXISTS bus_hourly_delays
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT time_bucket(INTERVAL '1 hour', fetched_at) AS bucket,
    feed_version_id, route_id,
    SUM(sample_count) AS sample_count,
    SUM(delay_sum) AS delay_sum,
    MAX(max_delay_seconds) AS max_delay_seconds,
    SUM(on_time_count) AS on_time_count,
    SUM(early_count) AS early_count,
    SUM(late_count) AS late_count,
    MAX(fetched_at) AS last_updated
FROM bus_route_poll_stats
GROUP BY bucket, feed_version_id, route_id
WITH NO DATA;
SELECT add_continuous_aggregate_policy('bus_hourly_delays',
    start_offset => INTERVAL '3 days', end_offset => INTERVAL '0 hours',
    schedule_interval => INTERVAL '5 minutes', if_not_exists => TRUE);
ALTER MATERIALIZED VIEW bus_hourly_delays SET (timescaledb.compress = true);
SELECT add_compression_policy('bus_hourly_delays', INTERVAL '7 days', if_not_exists => TRUE);
-- Intentionally no retention policy, matching rail history.

-- Preserve the complete public response body for fields the parser does not yet model.
-- Headers, URLs and API keys are never written here. Payloads are gzip-compressed JSON.
CREATE TABLE IF NOT EXISTS bus_realtime_feeds (
    fetched_at TIMESTAMPTZ NOT NULL,
    feed_version_id BIGINT NOT NULL,
    endpoint TEXT NOT NULL,
    payload_gzip BYTEA NOT NULL,
    PRIMARY KEY (fetched_at, endpoint)
);
SELECT create_hypertable('bus_realtime_feeds', 'fetched_at',
    chunk_time_interval => INTERVAL '1 day', if_not_exists => TRUE);
