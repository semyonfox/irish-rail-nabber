-- Migration: Severity 2 Schema Updates
-- Adds missing columns for train type classification, origin/destination times, and station classification
-- All changes are safe and additive (no data loss)

-- ============================================================================
-- STATIONS TABLE - Add type classification
-- ============================================================================

ALTER TABLE stations ADD COLUMN IF NOT EXISTS station_type CHAR(1);
ALTER TABLE stations ADD COLUMN IF NOT EXISTS is_dart BOOLEAN DEFAULT FALSE;

COMMENT ON COLUMN stations.station_type IS 'Station type: D=DART, M=Mainline, S=Suburban, A=Airport';
COMMENT ON COLUMN stations.is_dart IS 'True if this is a DART-serving station';

-- ============================================================================
-- STATION_EVENTS TABLE - Add journey time fields, remove broken server_time
-- ============================================================================

ALTER TABLE station_events ADD COLUMN IF NOT EXISTS origin_time TIME;
ALTER TABLE station_events ADD COLUMN IF NOT EXISTS destination_time TIME;

COMMENT ON COLUMN station_events.origin_time IS 'Scheduled departure time from journey origin';
COMMENT ON COLUMN station_events.destination_time IS 'Scheduled arrival time at journey destination';

-- Note: server_time column is not dropped (would be destructive)
-- but is no longer populated by daemon; use fetched_at for timestamps instead

-- ============================================================================
-- INDEXES - Add for new fields
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_stations_is_dart ON stations(is_dart);
