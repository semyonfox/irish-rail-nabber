-- HACON enriched train feed (undocumented endpoint: getHaconTrainsXML)
-- same trains as getCurrentTrainsXML but with structured fields the public feed lacks:
--   LastLocation / NextLocation as station codes (joinable to stations.station_code)
--   LastLocationType (A=Arrived, D=Departed, E=Expected, T=Terminated)
--   Difference in seconds (vs minute-resolution Late field elsewhere)
--   TrainOrigin / TrainDestination as codes, not prose names
--   Full datetimes (dd/MM/yyyy HH:mm:ss) instead of HH:MM[:SS] times
--
-- the API uses 01/01/1900 00:00:00 as a "no value" sentinel — that's the .NET DateTime
-- default and cannot be a real Irish Rail timestamp, so the daemon parses it to NULL
-- at ingest. (this is a deliberate exception to "store exactly what the API sends" —
-- documented because 1900 is unambiguous, unlike the 00:00 sentinel in other endpoints.)

CREATE TABLE IF NOT EXISTS train_snapshots_hacon (
    id                     BIGSERIAL,
    train_code             TEXT NOT NULL,
    train_status           CHAR(1),
    latitude               NUMERIC(9,6),
    longitude              NUMERIC(9,6),
    train_date             DATE,
    direction              TEXT,
    last_location_type     CHAR(1),
    last_location          TEXT,
    next_location          TEXT,
    difference_seconds     INT,
    train_origin           TEXT,
    train_destination      TEXT,
    train_origin_time      TIMESTAMP,
    train_destination_time TIMESTAMP,
    scheduled_departure    TIMESTAMP,
    scheduled_arrival      TIMESTAMP,
    fetched_at             TIMESTAMP NOT NULL,
    PRIMARY KEY (id, fetched_at)
);

SELECT create_hypertable('train_snapshots_hacon', 'fetched_at', if_not_exists => TRUE);

ALTER TABLE train_snapshots_hacon SET (
    timescaledb.compress,
    timescaledb.compress_orderby = 'fetched_at DESC, train_code',
    timescaledb.compress_chunk_time_interval = '7 days'
);

SELECT add_compression_policy('train_snapshots_hacon', INTERVAL '7 days', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_hacon_train ON train_snapshots_hacon(train_code, fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_hacon_lastloc ON train_snapshots_hacon(last_location, fetched_at DESC)
    WHERE last_location IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hacon_nextloc ON train_snapshots_hacon(next_location, fetched_at DESC)
    WHERE next_location IS NOT NULL;
