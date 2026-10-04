-- Published reporting-period aggregates have no individual observation timestamps.
-- Keep their original year/period and provenance, separate from realtime hypertables.
CREATE TABLE IF NOT EXISTS bus_published_imports (
    import_id TEXT PRIMARY KEY CHECK (import_id ~ '^[0-9a-f]{64}$'),
    source_url TEXT NOT NULL,
    imported_at TIMESTAMPTZ NOT NULL,
    source_updated_at TIMESTAMPTZ,
    record_count INTEGER NOT NULL CHECK (record_count > 0),
    first_year INTEGER NOT NULL,
    last_year INTEGER NOT NULL,
    raw_payload_gzip BYTEA NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX IF NOT EXISTS bus_published_one_active_import
    ON bus_published_imports ((true)) WHERE is_active;

CREATE TABLE IF NOT EXISTS bus_published_performance (
    import_id TEXT NOT NULL REFERENCES bus_published_imports(import_id),
    operator_name TEXT NOT NULL,
    route_short_name TEXT NOT NULL,
    report_year INTEGER NOT NULL CHECK (report_year BETWEEN 2000 AND 2100),
    report_period INTEGER NOT NULL CHECK (report_period BETWEEN 1 AND 13),
    on_time_pct DOUBLE PRECISION CHECK (on_time_pct BETWEEN 0 AND 100),
    early_pct DOUBLE PRECISION CHECK (early_pct BETWEEN 0 AND 100),
    late_pct DOUBLE PRECISION CHECK (late_pct BETWEEN 0 AND 100),
    actual_departures BIGINT CHECK (actual_departures >= 0),
    excess_wait_minutes DOUBLE PRECISION,
    planned_km DOUBLE PRECISION,
    actual_km DOUBLE PRECISION,
    lost_km DOUBLE PRECISION,
    contractual_lost_km DOUBLE PRECISION,
    PRIMARY KEY (import_id, operator_name, route_short_name, report_year, report_period)
);
CREATE INDEX IF NOT EXISTS bus_published_period
    ON bus_published_performance(import_id, report_year DESC, report_period DESC);
