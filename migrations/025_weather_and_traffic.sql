-- Met Éireann weather and TII road traffic counters, for lining delays up
-- against conditions. see context_collector.py for the sources.

CREATE TABLE IF NOT EXISTS weather_stations (
    station_id INTEGER PRIMARY KEY,  -- Met Éireann station number
    slug TEXT NOT NULL UNIQUE,       -- prodapi observations path
    name TEXT NOT NULL,
    lat DOUBLE PRECISION NOT NULL,
    lon DOUBLE PRECISION NOT NULL
);

CREATE TABLE IF NOT EXISTS weather_hourly (
    station_id INTEGER NOT NULL REFERENCES weather_stations(station_id),
    observed_at TIMESTAMPTZ NOT NULL,
    temp_c REAL,
    rain_mm REAL,
    -- knots in both feeds per Met Éireann's metadata
    wind_kt REAL,
    gust_kt REAL,
    wind_dir_deg REAL,
    humidity_pct REAL,
    pressure_hpa REAL,
    visibility_m REAL,
    weather_text TEXT,
    -- 'archive' is quality controlled and replaces 'live' for the same hour
    source TEXT NOT NULL,
    PRIMARY KEY (station_id, observed_at)
);

CREATE INDEX IF NOT EXISTS idx_weather_hourly_time ON weather_hourly (observed_at DESC);

CREATE TABLE IF NOT EXISTS weather_archive_progress (
    station_id INTEGER PRIMARY KEY REFERENCES weather_stations(station_id),
    last_modified TEXT,
    imported_through TIMESTAMPTZ NOT NULL,
    checked_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS weather_warnings (
    warning_key TEXT PRIMARY KEY,
    level TEXT,
    warning_type TEXT,
    headline TEXT,
    description TEXT,
    onset TIMESTAMPTZ,
    expiry TIMESTAMPTZ,
    regions JSONB NOT NULL,
    raw JSONB NOT NULL,
    first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS traffic_sites (
    site_id TEXT PRIMARY KEY,  -- TII dataserver id
    cosit TEXT,                -- counter id used by the bulk CSVs
    name TEXT,
    description TEXT,
    road_category TEXT,
    county TEXT,
    lat DOUBLE PRECISION,
    lon DOUBLE PRECISION,
    speed_limit_kmh INTEGER,
    bearing REAL,
    is_disabled BOOLEAN NOT NULL DEFAULT FALSE,
    yearly_checked_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_traffic_sites_cosit ON traffic_sites (cosit);

CREATE TABLE IF NOT EXISTS traffic_site_yearly (
    site_id TEXT NOT NULL REFERENCES traffic_sites(site_id),
    year INTEGER NOT NULL,
    aadt REAL,              -- annual average daily traffic
    coverage REAL,          -- share of the year with data, 0 to 1
    total_count DOUBLE PRECISION,
    hgv_per_mille REAL,
    PRIMARY KEY (site_id, year)
);

-- TII only exposes a rolling seven-day window per site, so one snapshot a day
-- builds a history. source_days says which days the window covered
CREATE TABLE IF NOT EXISTS traffic_site_weekly (
    site_id TEXT NOT NULL REFERENCES traffic_sites(site_id),
    captured_on DATE NOT NULL,
    source_days DATE[] NOT NULL,
    total_count DOUBLE PRECISION,
    avg_speed_kmh REAL,
    workday_avg_speed_kmh REAL,
    speed_profile JSONB NOT NULL,
    by_direction JSONB NOT NULL,
    PRIMARY KEY (site_id, captured_on)
);

-- data.tii.ie daily counts per counter and vehicle class, June 2013 to April 2021
CREATE TABLE IF NOT EXISTS traffic_daily_class (
    cosit TEXT NOT NULL,
    day DATE NOT NULL,
    vehicle_class SMALLINT NOT NULL,
    vehicles INTEGER NOT NULL,
    PRIMARY KEY (cosit, day, vehicle_class)
);

CREATE TABLE IF NOT EXISTS traffic_bulk_days (
    day DATE PRIMARY KEY,
    rows INTEGER NOT NULL,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
