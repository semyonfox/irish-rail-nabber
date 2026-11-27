-- keep poll-weighted delay counts without storing repeated stop predictions
-- the collector still archives only changes in bus_stop_observations

CREATE TABLE IF NOT EXISTS bus_delay_histogram (
    bucket TIMESTAMPTZ NOT NULL,
    scope_kind TEXT NOT NULL,
    feed_version_id BIGINT NOT NULL,
    scope_id TEXT NOT NULL,
    delay_seconds INTEGER NOT NULL,
    sample_count BIGINT NOT NULL,
    last_updated TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (bucket, scope_kind, feed_version_id, scope_id, delay_seconds)
);

SELECT create_hypertable('bus_delay_histogram', 'bucket',
    chunk_time_interval => INTERVAL '1 day', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS bus_delay_histogram_scope
    ON bus_delay_histogram (scope_kind, feed_version_id, scope_id, bucket DESC);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM timescaledb_information.hypertables
        WHERE hypertable_name = 'bus_delay_histogram' AND compression_enabled
    ) THEN
        ALTER TABLE bus_delay_histogram SET (
            timescaledb.compress,
            timescaledb.compress_segmentby = 'scope_kind,feed_version_id,scope_id',
            timescaledb.compress_orderby = 'bucket DESC,delay_seconds'
        );
    END IF;
END $$;
SELECT add_compression_policy('bus_delay_histogram', INTERVAL '7 days',
    if_not_exists => TRUE);

-- a retry of the same poll must not double its histogram counts
CREATE TABLE IF NOT EXISTS bus_histogram_polls (
    fetched_at TIMESTAMPTZ NOT NULL,
    feed_version_id BIGINT NOT NULL,
    PRIMARY KEY (fetched_at, feed_version_id)
);
SELECT create_hypertable('bus_histogram_polls', 'fetched_at',
    chunk_time_interval => INTERVAL '1 day', if_not_exists => TRUE);

-- exact weighted percentile from histogram bins without expanding samples
CREATE OR REPLACE FUNCTION bus_histogram_percentile(
    vals INTEGER[], weights BIGINT[], p DOUBLE PRECISION
) RETURNS DOUBLE PRECISION LANGUAGE SQL IMMUTABLE PARALLEL SAFE AS $$
    WITH counts AS (
        SELECT v, SUM(w) AS n FROM unnest(vals, weights) t(v,w)
        WHERE w > 0 GROUP BY v
    ), ranked AS (
        SELECT v, SUM(n) OVER(ORDER BY v) AS cumulative,
               SUM(n) OVER() AS total FROM counts
    ), bounds AS (
        SELECT MIN(v) FILTER(WHERE cumulative >= FLOOR((total - 1) * p) + 1) AS lo,
               MIN(v) FILTER(WHERE cumulative >= CEIL((total - 1) * p) + 1) AS hi,
               MAX((total - 1) * p - FLOOR((total - 1) * p)) AS fraction
        FROM ranked
    ) SELECT lo + (hi::float8 - lo) * fraction FROM bounds;
$$;
