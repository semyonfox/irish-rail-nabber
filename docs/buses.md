# Bus data

The bus collector adds NTA GTFS schedules, realtime trip updates and current vehicle positions beside the existing Irish Rail feed. It does not replace or rename the rail tables.

## Sources

| Data | URL | Access | Refresh |
|---|---|---|---|
| Matching GTFS schedule | `https://www.transportforireland.ie/transitData/Data/GTFS_Realtime.zip` | public | daily |
| Combined GTFS-Realtime feed | `https://api.nationaltransport.ie/gtfsr/v2/gtfsr?format=json` | `x-api-key` | once per minute |

The collector keeps only routes whose GTFS `route_type` is `3`, plus their agencies, trips, stops, stop times, predictions and vehicle positions. The combined endpoint carries TripUpdate and VehiclePosition entities in one response, so tracking does not consume a second request. The NTA fair-usage policy limits each token to one realtime API call every 60 seconds.

NTA data uses CC BY 4.0. Public views must name the NTA, link to the source and say that the data is supplied as is. The dashboard bus page includes this notice. Review the NTA's commercial-use wording before placing bus data behind a paid plan.

## Why schedules are versioned

NTA route, trip and stop IDs are internal join keys. They can change when the schedule is regenerated. Realtime rows are therefore tied to the exact static feed SHA-256 and `feed_version_id` that was active when the collector received them.

Old feed versions remain in the database so historical departures still resolve to the right stop, route and operator. A new static feed becomes active only after its related rows load successfully in one transaction.

## Tables

```text
transit_feed_versions
  ├── bus_agencies
  ├── bus_routes
  ├── bus_trips
  ├── bus_stops
  └── bus_stop_times

bus_stop_updates
  └── content-deduplicated arrival/departure predictions and delays

bus_trip_update_freshness
  └── current TripUpdate presence, relationship and last-seen time

bus_vehicle_positions
  └── one current row per vehicle in the latest full-dataset response
```

GTFS schedule times use integer seconds since the start of the service day. This preserves valid values beyond `24:00:00`, which PostgreSQL `TIME` cannot represent.

## Runtime

`bus_daemon.py` performs two independent jobs:

1. Download and import the matching static feed when its SHA-256 changes.
2. Fetch the full GTFS-Realtime dataset no more than once per minute, append changed stop states, refresh current trip presence, and replace the current vehicle snapshot.

The static import still runs when `NTA_API_KEY` is empty. Realtime collection stays disabled until the key is present. The key is sent only in the `x-api-key` header and must never appear in logs.

The database-backed request reservation adds a one-second safety margin and applies across restarts or concurrent collectors sharing the database. Differential feeds are rejected because absence only means removal in a full-dataset feed. Trip-level freshness lets boards retire removed or canceled trips without rewriting every unchanged stop prediction each minute.

The current NTA archive contains about 6.6 million bus stop-time rows. Route, trip and stop metadata remains versioned so historical IDs can still be interpreted, but stop times for inactive versions are removed after the replacement feed activates. Changed stop predictions are retained for seven days by default and pruned at most once per day; vehicle positions are current state rather than an append-only history. This bounds the two largest storage risks on the production host.

Configuration:

| Variable | Default |
|---|---|
| `DATABASE_URL` | required |
| `NTA_API_KEY` | empty, realtime disabled |
| `NTA_GTFS_URL` | matching NTA static ZIP |
| `NTA_GTFSR_URL` | NTA v2 combined GTFS-Realtime JSON endpoint |
| `NTA_TRIP_UPDATES_URL` | legacy fallback name for `NTA_GTFSR_URL` |
| `BUS_STATIC_REFRESH_SECONDS` | `86400` |
| `BUS_REALTIME_INTERVAL_SECONDS` | `60`, values below 60 are clamped |
| `BUS_REALTIME_RETENTION_DAYS` | `7`, must be positive |

## GraphQL

```graphql
busStops(search: String, limit: Int = 50)
busStopBoard(stopId: String!, limit: Int = 30)
busRouteDelays(hours: Int = 24, limit: Int = 30)
busVehicles(routeId: String, limit: Int = 2000)
```

All four return an empty list before the first feed import. Stops, boards, current vehicles and up to 72 hours of route-delay history are public. Coffee, Pro and admin accounts may query the full seven-day retained window. Identical stop searches, boards, delay aggregates and vehicle snapshots are coalesced and cached briefly in the API.

## Checks

```bash
python -m unittest test_bus_daemon.py
python -m py_compile bus_daemon.py

cd api
cargo test --all-targets

cd ../dashboard
vp check
vp build
```

After starting the stack:

```sql
SELECT id, content_sha256, imported_at, is_active
FROM transit_feed_versions
ORDER BY imported_at DESC;

SELECT COUNT(*) FROM bus_stops
WHERE feed_version_id = (
  SELECT id FROM transit_feed_versions WHERE is_active ORDER BY imported_at DESC LIMIT 1
);

SELECT COUNT(*) FROM bus_stop_updates
WHERE fetched_at > NOW() - INTERVAL '10 minutes';

SELECT COUNT(*), MAX(last_seen_at) FROM bus_vehicle_positions;
```

## Official references

- [NTA GTFS dataset](https://data.gov.ie/dataset/nta-gtfs)
- [NTA GTFS-Realtime migration and ID guidance](https://www.nationaltransport.ie/news/attention-developers-upgrade-to-gtfs-realtime-api/)
- [NTA fair-usage policy](https://developer.nationaltransport.ie/usagepolicy)
