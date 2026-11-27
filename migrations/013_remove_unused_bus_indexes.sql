-- The API reads current stop boards by stop ID and route statistics by trip
-- freshness. Neither query filters bus_stop_updates by route or by last_seen_at
-- with a non-null delay. Keep the stop and trip indexes. The stop-update
-- retention index is obsolete now that the full history is archived.
-- CONCURRENTLY avoids blocking live polling while PostgreSQL drops these.
DROP INDEX CONCURRENTLY IF EXISTS idx_bus_stop_updates_recent_delays;
DROP INDEX CONCURRENTLY IF EXISTS idx_bus_stop_updates_route_latest;
DROP INDEX CONCURRENTLY IF EXISTS idx_bus_stop_updates_retention;
