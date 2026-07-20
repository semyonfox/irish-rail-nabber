-- Compact, append-friendly history payloads. Empty scope_code is the network rollup.
CREATE TABLE IF NOT EXISTS delay_history_hourly (
    bucket TIMESTAMP NOT NULL,
    scope_code TEXT NOT NULL,
    avg_late_minutes DOUBLE PRECISION NOT NULL,
    p95_late_minutes DOUBLE PRECISION NOT NULL,
    max_late_minutes INTEGER NOT NULL,
    on_time_pct DOUBLE PRECISION NOT NULL,
    event_count BIGINT NOT NULL,
    refreshed_at TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (scope_code, bucket)
);

CREATE INDEX IF NOT EXISTS idx_delay_history_hourly_bucket
    ON delay_history_hourly (bucket DESC);

-- Backfill exactly once. Future updates are maintained incrementally by the daemon.
INSERT INTO delay_history_hourly (
    bucket, scope_code, avg_late_minutes, p95_late_minutes,
    max_late_minutes, on_time_pct, event_count
)
SELECT
    date_trunc('hour', fetched_at),
    CASE WHEN GROUPING(station_code) = 1 THEN '' ELSE station_code END,
    AVG(late_minutes)::float8,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY late_minutes)::float8,
    MAX(late_minutes),
    (COUNT(*) FILTER (WHERE late_minutes <= 5) * 100.0 / COUNT(*))::float8,
    COUNT(*)
FROM station_events
WHERE late_minutes IS NOT NULL
    AND station_code IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM delay_history_hourly LIMIT 1)
    AND NOT (
        ABS(late_minutes) > 720
        OR (
            late_minutes < -60
            AND COALESCE(expected_arrival, expected_departure) IS NOT NULL
            AND COALESCE(NULLIF(scheduled_arrival, TIME '00:00'), NULLIF(scheduled_departure, TIME '00:00'), scheduled_arrival, scheduled_departure) IS NOT NULL
            AND COALESCE(expected_arrival, expected_departure) < COALESCE(NULLIF(scheduled_arrival, TIME '00:00'), NULLIF(scheduled_departure, TIME '00:00'), scheduled_arrival, scheduled_departure)
        )
    )
GROUP BY GROUPING SETS (
    (date_trunc('hour', fetched_at), station_code),
    (date_trunc('hour', fetched_at))
)
ON CONFLICT (scope_code, bucket) DO NOTHING;
