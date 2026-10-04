-- Exact delay distributions avoid repeatedly scanning the observation archive.
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
    ON bus_delay_histogram(scope_kind, feed_version_id, scope_id, bucket DESC);
ALTER TABLE bus_delay_histogram SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'scope_kind, feed_version_id, scope_id',
    timescaledb.compress_orderby = 'bucket DESC, delay_seconds'
);
SELECT add_compression_policy('bus_delay_histogram', INTERVAL '7 days', if_not_exists => TRUE);

CREATE TABLE IF NOT EXISTS bus_histogram_polls (
    fetched_at TIMESTAMPTZ NOT NULL,
    feed_version_id BIGINT NOT NULL,
    PRIMARY KEY(fetched_at, feed_version_id)
);
SELECT create_hypertable('bus_histogram_polls', 'fetched_at',
    chunk_time_interval => INTERVAL '1 day', if_not_exists => TRUE);

CREATE OR REPLACE FUNCTION record_bus_delay_histogram(p_time TIMESTAMPTZ, p_version BIGINT)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO bus_histogram_polls VALUES(p_time, p_version) ON CONFLICT DO NOTHING;
    IF NOT FOUND THEN RETURN; END IF;
    INSERT INTO bus_delay_histogram
    SELECT time_bucket(INTERVAL '1 hour', p_time), scope.kind, p_version, scope.id,
           COALESCE(u.departure_delay_seconds, u.arrival_delay_seconds),
           COUNT(*), p_time
    FROM bus_stop_observations u
    CROSS JOIN LATERAL (VALUES ('network',''), ('route',u.route_id), ('stop',u.stop_id)) scope(kind,id)
    WHERE u.fetched_at = p_time AND u.feed_version_id = p_version AND scope.id IS NOT NULL
      AND COALESCE(u.departure_delay_seconds, u.arrival_delay_seconds) IS NOT NULL
      AND u.trip_schedule_relationship NOT IN ('CANCELED','CANCELLED','DELETED')
      AND COALESCE(u.schedule_relationship,'SCHEDULED') NOT IN ('SKIPPED','NO_DATA','CANCELED','CANCELLED','DELETED')
    GROUP BY scope.kind, scope.id, COALESCE(u.departure_delay_seconds, u.arrival_delay_seconds)
    ON CONFLICT (bucket, scope_kind, feed_version_id, scope_id, delay_seconds)
    DO UPDATE SET sample_count = bus_delay_histogram.sample_count + EXCLUDED.sample_count,
                  last_updated = GREATEST(bus_delay_histogram.last_updated, EXCLUDED.last_updated);
END $$;

-- Equivalent to percentile_cont without expanding repeated samples or averaging percentiles.
CREATE OR REPLACE FUNCTION bus_histogram_percentile(vals INTEGER[], weights BIGINT[], p DOUBLE PRECISION)
RETURNS DOUBLE PRECISION LANGUAGE SQL IMMUTABLE PARALLEL SAFE AS $$
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
