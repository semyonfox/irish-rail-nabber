-- Where delay is picked up, stop to stop. Sums rather than averages so days,
-- hours and routes can be added together and averaged at read time.
-- gain is delay on reaching the next stop minus delay on leaving this one.

-- written by the bus daemon as each trip finishes. NTA republishes its timetable
-- daily but keeps stop ids, so rows are per stop pair and feed_version_id is
-- just the newest version seen, for names, coordinates and route ids
CREATE TABLE IF NOT EXISTS bus_segment_delay_hourly (
    service_date DATE NOT NULL,
    -- scheduled departure hour from from_stop_id, Irish local time
    hour_local SMALLINT NOT NULL,
    from_stop_id TEXT NOT NULL,
    to_stop_id TEXT NOT NULL,
    feed_version_id BIGINT NOT NULL REFERENCES transit_feed_versions(id),
    trips INTEGER NOT NULL,
    gain_sum_s BIGINT NOT NULL,
    gain_pos_sum_s BIGINT NOT NULL,
    gain_sq_sum BIGINT NOT NULL,
    max_gain_s INTEGER NOT NULL,
    run_sum_s BIGINT NOT NULL,
    sched_run_sum_s BIGINT NOT NULL,
    -- trip counts per signed gain bucket, edges -300 -120 -60 -30 0 30 60 120 300 s
    gain_hist INTEGER[] NOT NULL,
    route_ids TEXT[] NOT NULL DEFAULT '{}',
    PRIMARY KEY (service_date, hour_local, from_stop_id, to_stop_id)
);

CREATE INDEX IF NOT EXISTS idx_bus_segment_delay_pair
    ON bus_segment_delay_hourly (from_stop_id, to_stop_id, service_date);

-- written by the rail daemon once a service day is over
CREATE TABLE IF NOT EXISTS rail_segment_delay_hourly (
    service_date DATE NOT NULL,
    hour_local SMALLINT NOT NULL,
    from_code TEXT NOT NULL,
    to_code TEXT NOT NULL,
    trains INTEGER NOT NULL,
    gain_sum_s BIGINT NOT NULL,
    gain_pos_sum_s BIGINT NOT NULL,
    gain_sq_sum BIGINT NOT NULL,
    max_gain_s INTEGER NOT NULL,
    run_sum_s BIGINT NOT NULL,
    sched_run_sum_s BIGINT NOT NULL,
    PRIMARY KEY (service_date, hour_local, from_code, to_code)
);

CREATE INDEX IF NOT EXISTS idx_rail_segment_delay_pair
    ON rail_segment_delay_hourly (from_code, to_code, service_date);

-- delay picked up while standing at a station
CREATE TABLE IF NOT EXISTS rail_dwell_delay_hourly (
    service_date DATE NOT NULL,
    hour_local SMALLINT NOT NULL,
    station_code TEXT NOT NULL,
    trains INTEGER NOT NULL,
    gain_sum_s BIGINT NOT NULL,
    gain_pos_sum_s BIGINT NOT NULL,
    max_gain_s INTEGER NOT NULL,
    dwell_sum_s BIGINT NOT NULL,
    sched_dwell_sum_s BIGINT NOT NULL,
    PRIMARY KEY (service_date, hour_local, station_code)
);

CREATE TABLE IF NOT EXISTS rail_segment_rollup_days (
    service_date DATE PRIMARY KEY,
    legs INTEGER NOT NULL,
    computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
