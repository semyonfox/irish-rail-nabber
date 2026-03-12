-- Migration: Add train_date to station_events
-- needed to disambiguate train journeys (train codes are reused daily)
-- the API provides <Traindate> but the original schema didn't store it

ALTER TABLE station_events ADD COLUMN IF NOT EXISTS train_date DATE;

COMMENT ON COLUMN station_events.train_date IS 'Train journey date from API Traindate field, needed to link events to specific journeys';

CREATE INDEX IF NOT EXISTS idx_station_events_train_date ON station_events(train_date);
