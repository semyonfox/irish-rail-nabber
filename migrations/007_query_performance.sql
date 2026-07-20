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
