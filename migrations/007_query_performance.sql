-- Keep recent analytics cheap as station_events grows.
CREATE INDEX IF NOT EXISTS idx_station_events_recent_delay
    ON station_events (fetched_at DESC, station_code)
    WHERE late_minutes IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_station_events_latest_train_station
    ON station_events (train_code, station_code, fetched_at DESC)
    INCLUDE (late_minutes, origin, destination);

CREATE INDEX IF NOT EXISTS idx_train_movements_recent_journey
    ON train_movements (fetched_at DESC, train_code, train_date, location_order)
    INCLUDE (location_code)
    WHERE location_type <> 'T' AND location_code IS NOT NULL;

-- The old policy left the newest complete hour unavailable for up to an hour.
-- Refresh a narrow recent window frequently; older buckets remain materialized.
SELECT remove_continuous_aggregate_policy('hourly_delays', if_exists => TRUE);
SELECT add_continuous_aggregate_policy('hourly_delays',
    start_offset => INTERVAL '3 hours',
    end_offset => INTERVAL '1 minute',
    schedule_interval => INTERVAL '5 minutes',
    if_not_exists => TRUE
);
