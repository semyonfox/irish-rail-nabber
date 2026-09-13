# Bus data

The bus collector adds NTA GTFS schedules, realtime trip updates and current vehicle positions beside the existing Irish Rail feed. It does not replace or rename the rail tables.

## Sources

| Data | URL | Access | Refresh |
|---|---|---|---|
| Matching GTFS schedule | `https://www.transportforireland.ie/transitData/Data/GTFS_Realtime.zip` | public | daily |
| TripUpdates | `https://api.nationaltransport.ie/gtfsr/v2/gtfsr?format=json` | `x-api-key` | alternating, normally about every two minutes |
| Vehicles | `https://api.nationaltransport.ie/gtfsr/v2/Vehicles?format=json` | `x-api-key` | alternating, normally about every two minutes |

The collector keeps only routes whose GTFS `route_type` is `3` or `11`, or the extended bus/coach types `200–209`, `700–716` and `800`, plus their agencies, trips, stops, stop times, predictions and vehicle positions. The NTA exposes trip updates and vehicle positions through separate operations, but its fair-usage policy permits only one realtime API request per token every 60 seconds. The collector therefore alternates the operations within one shared request budget. With the one-second safety margin, each kind normally refreshes about every 122 seconds.

The NTA describes its live feed as covering services provided by Dublin Bus, Bus Éireann and Go-Ahead Ireland. The matching static schedule covers a broader bus network, so a route appearing in the schedule does not by itself mean realtime positions are available for it.

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
  ├── bus_stop_times
  └── bus_shape_points

bus_stop_updates
  └── content-deduplicated arrival/departure predictions and delays

bus_trip_update_freshness
  └── current TripUpdate presence, relationship and last-seen time

bus_vehicle_positions
  └── one current row per vehicle in the latest full-dataset Vehicles response
```

GTFS schedule times use integer seconds since the start of the service day. This preserves valid values beyond `24:00:00`, which PostgreSQL `TIME` cannot represent.

## Runtime

`bus_daemon.py` performs two independent jobs:

1. Download and import the matching static feed when its SHA-256 changes.
2. Reserve one shared realtime request slot, then alternate TripUpdates and Vehicles. TripUpdates appends changed stop states and refreshes current trip presence. Vehicles replaces the current vehicle snapshot.

The static import still runs when `NTA_API_KEY` is empty. Realtime collection stays disabled until the key is present. The key is sent only in the `x-api-key` header and must never appear in logs.

The database-backed request reservation adds a one-second safety margin and applies across restarts or concurrent collectors sharing the database. Both operations use the same reservation, so replicas cannot turn the alternating schedule into extra NTA requests. The API reads the resulting database state and serves it to every user without calling NTA again.

Differential feeds are rejected because absence only means removal in a full-dataset feed. TripUpdates changes only stop predictions and trip freshness; Vehicles changes only the vehicle snapshot. One operation never clears the other operation's data. Trip-level freshness lets boards retire removed or canceled trips without rewriting every unchanged stop prediction.

The current NTA archive contains about 6.6 million bus stop-time rows. Route, trip and stop metadata remains versioned so historical IDs can still be interpreted, but stop times and shape points for inactive versions are removed after the replacement feed activates. A historical feed is rehydrated from its archive before it can become active again. Changed stop predictions are retained for seven days by default and pruned at most once per day; vehicle positions are current state rather than an append-only history.

Configuration:

| Variable | Default |
|---|---|
| `DATABASE_URL` | required |
| `NTA_API_KEY` | empty, realtime disabled |
| `NTA_GTFS_URL` | matching NTA static ZIP |
| `NTA_TRIP_UPDATES_URL` | NTA v2 TripUpdates JSON endpoint |
| `NTA_VEHICLES_URL` | NTA v2 Vehicles JSON endpoint |
| `NTA_GTFSR_URL` | deprecated fallback for `NTA_TRIP_UPDATES_URL` |
| `BUS_GTFS_ARCHIVE_DIRECTORY` | optional outside Docker; `/data/gtfs` in Compose |
| `BUS_STATIC_REFRESH_SECONDS` | `86400` |
| `BUS_REALTIME_INTERVAL_SECONDS` | `60`, shared by both operations; values below 60 are clamped |
| `BUS_REALTIME_RETENTION_DAYS` | `7`, must be positive |

## GraphQL

```graphql
busStops(search: String, limit: Int = 50)
busRealtimeStatus
busStopBoard(stopId: String!, limit: Int = 30)
busRouteDelays(hours: Int = 24, limit: Int = 30)
busVehicles(routeId: String, limit: Int = 2000)
busLiveRouteShapes(limit: Int = 100)
busScheduledRouteShapes(stopId: String, limit: Int = 24)
```

The list queries return an empty list before the first feed import. `busRealtimeStatus` reports the newest successful TripUpdates or Vehicles poll and only marks the feed live for three minutes after that poll. Stops, boards, current vehicles, scheduled route shapes and up to 72 hours of route-delay history are public. Coffee, Pro and admin accounts may query the full seven-day retained window.

`busLiveRouteShapes` only considers trips with a vehicle seen in the last five minutes. It returns at most 100 shapes and samples each to at most 500 ordered points. It stays empty until realtime collection succeeds.

`busScheduledRouteShapes` does not depend on realtime. Without `stopId`, it returns representative directions from the most frequently scheduled routes in the active feed. With `stopId`, it returns representative directions for routes serving that stop. The API returns at most 40 shapes, samples each to at most 300 points, and keeps one common shape per route and direction. The dashboard requests 24. This gives the map useful route lines in static-only mode without sending the full national feed to the browser.

Identical stop searches, boards, delay aggregates, vehicle snapshots and route shapes are coalesced and cached in the API. Non-empty scheduled geometry uses a 15-minute cache because it changes only when the static feed changes. Empty scheduled-shape results are evicted immediately, so a request made during the initial shape import cannot hide the completed import for 15 minutes.

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

SELECT endpoint, status, fetched_at, record_count
FROM fetch_history
WHERE endpoint IN ('nta_trip_updates', 'nta_vehicles')
ORDER BY fetched_at DESC
LIMIT 10;
```

The last query should show both realtime endpoints alternating, with consecutive requests at least 60 seconds apart.

## Official references

- [GTFS `shapes.txt` reference](https://gtfs.org/documentation/schedule/reference/#shapestxt)
- [NTA GTFS dataset](https://data.gov.ie/dataset/nta-gtfs)
- [NTA GTFS-Realtime migration and ID guidance](https://www.nationaltransport.ie/news/attention-developers-upgrade-to-gtfs-realtime-api/)
- [NTA fair-usage policy](https://developer.nationaltransport.ie/usagepolicy)

## Persistent bulk archive and regional coverage

The database already stores the imported national schedule and current realtime
snapshots. API requests read that state rather than calling NTA for each visitor.
The bus collector now also keeps the exact last successfully imported ZIP in the
`bus_gtfs_archives` Docker volume. Filenames are the SHA-256 of the source URL,
followed by `.zip`. Replacement is atomic, failed imports keep the previous copy,
and there is one archive per configured source URL. The complete ZIP retains
calendar files and other source tables even when the importer does not use them.
An upstream outage leaves the imported database schedule available. The collector
does not activate an older archive automatically, because its IDs may no longer
match current realtime data.

Regional bus and coach route types are accepted on subsequent new feed imports,
alongside ordinary buses. Existing imported versions remain immutable. A separate
operator ZIP must not replace the matching realtime schedule simply to add routes:
its IDs may collide or fail to match NTA's live feed. Additional independent feeds
need separate source/version handling before they can be combined safely.

Route types: [published extended GTFS types](https://developers.google.com/transit/gtfs/reference/extended-route-types).

The matching ZIP inspected on 13 September 2026 contained 382 bus routes:
197 Bus Éireann, 5 Bus Éireann Waterford, 116 Dublin Bus and 64 Go-Ahead Ireland.
All used route type 3, so accepting extended types does not add routes to that
particular archive. It prepares the importer for regional/coach feeds using those
codes; it does not create live coverage where the operator publishes none.

NTA's [download catalogue](https://www.transportforireland.ie/transitData/PT_Data.html)
also lists [all operators](https://www.transportforireland.ie/transitData/Data/GTFS_All.zip),
[Local Link](https://www.transportforireland.ie/transitData/Data/GTFS_Local_Link.zip),
[Citylink](https://www.transportforireland.ie/transitData/Data/GTFS_Citylink.zip),
Aircoach, JJ Kavanagh, Wexford Bus and smaller operators as separate schedule
archives. These are candidates for additional scheduled coverage, not evidence of
additional realtime positions. They are not automatically imported alongside the
matching realtime schedule by this collector.
