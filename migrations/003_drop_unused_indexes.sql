-- drop indexes with 0 scans at chunk level, on columns never used in queries
-- saves ~324 MB and reduces write amplification on inserts

-- station_events: origin_time and destination_time columns never queried
DROP INDEX IF EXISTS idx_station_events_origin_time;
DROP INDEX IF EXISTS idx_station_events_destination_time;

-- station_events: train_type never filtered or grouped in analysis
DROP INDEX IF EXISTS idx_station_events_type;

-- stations: station_type never used in any WHERE/GROUP BY
DROP INDEX IF EXISTS idx_stations_type;

-- train_movements: location_code never used in WHERE clauses
DROP INDEX IF EXISTS idx_train_movements_location;
