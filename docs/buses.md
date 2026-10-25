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

bus_stop_observations
  └── compressed archive of each changed stop prediction

bus_stop_live
  └── latest prediction per active trip and stop for departure boards

bus_delay_samples
  └── latest non-null delay per trip and stop for seven-day route statistics

bus_trip_update_freshness
  └── recent TripUpdate presence, relationship and last-seen time

bus_trip_observations
  └── compressed archive of trip presence at each successful poll

bus_vehicle_positions
  └── one current row per vehicle in the latest full-dataset Vehicles response

bus_vehicle_observations
  └── compressed archive of each full vehicle snapshot

bus_delay_histogram
  └── hourly counts of each reported prediction delay by network, route and stop

bus_histogram_polls
  └── poll receipts that prevent duplicate histogram counts after a retry

bus_published_imports
  └── each imported NTA published-performance snapshot, with its raw source responses

bus_published_performance
  └── published route-period statistics for each snapshot

```

The backfill copied every surviving legacy stop state and trip-presence row
before the legacy table was retired. That table deduplicated repeated stop
states, and an earlier retention job had already removed some older rows, so
polls and changes missing from it cannot be reconstructed. New observations
are archived as they arrive. The verified pre-retirement backup retains the
legacy table for recovery.

GTFS schedule times use integer seconds since the start of the service day. This preserves valid values beyond `24:00:00`, which PostgreSQL `TIME` cannot represent.

## Runtime

`bus_daemon.py` performs two independent jobs:

1. Download and import the matching static feed when its SHA-256 changes.
2. Reserve one shared realtime request slot, then alternate TripUpdates and Vehicles. TripUpdates appends changed stop states and records trip presence. Vehicles replaces the current vehicle snapshot and archives every vehicle seen in each poll.

If an active static feed already exists, realtime polling starts during the
startup static refresh and continues while that feed imports. A first install
waits for its initial static feed before polling realtime data.

The static import still runs when `NTA_API_KEY` is empty. Realtime collection stays disabled until the key is present. The key is sent only in the `x-api-key` header and must never appear in logs.

The database-backed request reservation adds a one-second safety margin and applies across restarts or concurrent collectors sharing the database. Both operations use the same reservation, so replicas cannot turn the alternating schedule into extra NTA requests. The API reads the resulting database state and serves it to every user without calling NTA again.

Differential feeds are rejected because absence only means removal in a full-dataset feed. TripUpdates changes only stop predictions and trip freshness; Vehicles changes only the vehicle snapshot. One operation never clears the other operation's data. Trip-level freshness lets boards retire removed or canceled trips without rewriting every unchanged stop prediction. The board reads `bus_stop_live`; the statistics page reads `bus_delay_samples` joined to recent trip freshness. Predictions and poll presence remain in the compressed observation tables after the live and statistics projections expire.

The current NTA archive contains about 6.6 million bus stop-time rows. Route, trip and stop metadata remains versioned so historical IDs can still be interpreted, but stop times and shape points for inactive versions are removed after the replacement feed activates. Each successfully imported static ZIP is kept by content hash under `BUS_GTFS_ARCHIVE_DIRECTORY/versions` so the matching schedule can be restored; older versions that predate this archive may lack their ZIP. Stop prediction changes, trip observations and full vehicle snapshots have no retention limit. The observation hypertables compress after three hours; no bus or train history retention policy deletes old observations. Finite disks still need capacity monitoring as the archive grows.

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
| `BUS_WRITE_LEGACY_STOP_UPDATES` | `0`; `1` is only for rollback to a database that still has the legacy table |

## GraphQL

```graphql
busStops(search: String, limit: Int = 50)
busRealtimeStatus
busStopBoard(stopId: String!, limit: Int = 30)
busRouteDelays(hours: Int = 24, limit: Int = 30)
busVehicles(routeId: String, limit: Int = 2000)
busLiveRouteShapes(limit: Int = 100)
busScheduledRouteShapes(stopId: String, limit: Int = 24)
busDelayHistory(routeId: String, stopId: String, feedVersionId: Int, hours: Int = 24, resolution: BusHistoryResolution = HOUR)
busRoutes(search: String, routeId: String, feedVersionId: Int, limit: Int = 60)
busStopStats(hours: Int = 24, search: String, feedVersionId: Int, stopId: String, limit: Int = 100)
busRouteStopDelays(routeId: String!, feedVersionId: Int!, limit: Int = 100)
busJourneys(feedVersionId: Int!, routeId: String!, hours: Int = 24, limit: Int = 100)
busJourneyStops(feedVersionId: Int!, routeId: String!, tripInstanceKey: String!, hours: Int = 72)
busPublishedDataset
busPublishedPerformance(importId: String!, search: String, operatorName: String, routeShortName: String, year: Int, limit: Int = 200, offset: Int = 0)
```

`busDelayHistory` derives hourly averages, p95 and on-time shares from the
poll-weighted histogram. It counts unchanged predictions again when they are
reported in a later poll, and is not a measure of actual arrivals. Choose at
most one of `routeId` and `stopId`; either requires `feedVersionId` so schedule
versions remain distinct. Missing polls remain gaps in the series. `HOUR`
resolution covers up to 168 hours, longer windows must ask for `DAY`, whose
buckets start at midnight UTC. History windows are described below.
The existing `busRouteDelays` ranking has different semantics: its samples are
the latest recorded delay per trip and stop, not one sample per poll.

The list queries return an empty list before the first feed import. `busRealtimeStatus`
reports the newest successful poll plus separate `vehiclesLastSuccessAt` and
`tripUpdatesLastSuccessAt` timestamps. Its legacy `isLive` field means either
feed succeeded in the last three minutes; the dashboard uses the source-specific
times so fresh predictions cannot make stale vehicle positions appear live.
Stops, boards, current vehicles, scheduled route shapes and up to 72 hours of
route-delay history are public. Coffee, Pro and admin accounts may query up to
seven days through the route-delay API.

`busLiveRouteShapes` only considers trips with a vehicle seen in the last five minutes. It returns at most 100 shapes and samples each to at most 500 ordered points. It stays empty until realtime collection succeeds.

`busScheduledRouteShapes` does not depend on realtime. Without `stopId`, it returns representative directions from the most frequently scheduled routes in the active feed. With `stopId`, it returns representative directions for routes serving that stop. The API returns at most 40 shapes, samples each to at most 300 points, and keeps one common shape per route and direction. The dashboard requests 24. This gives the map useful route lines in static-only mode without sending the full national feed to the browser.

Identical stop searches, boards, delay aggregates, vehicle snapshots and route shapes are coalesced and cached in the API. Non-empty scheduled geometry uses a 15-minute cache because it changes only when the static feed changes. Empty scheduled-shape results are evicted immediately, so a request made during the initial shape import cannot hide the completed import for 15 minutes.

The live dashboard polls positions and selected-stop boards every 15 seconds.
It fetches map geometry separately every 60 seconds, so a slow shape query does
not delay positions. The network page refreshes route statistics every minute.
These browser requests read our cached API and consume no additional NTA
requests. The map transition ends at each reported position; it does not
predict movement between upstream polls.

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

SELECT COUNT(*) FROM bus_stop_observations
WHERE fetched_at > NOW() - INTERVAL '10 minutes';

SELECT COUNT(*), MAX(last_seen_at) FROM bus_vehicle_positions;

SELECT endpoint, status, fetched_at, record_count
FROM fetch_history
WHERE endpoint IN ('nta_trip_updates', 'nta_vehicles')
ORDER BY fetched_at DESC
LIMIT 10;
```

The last query should show both realtime endpoints alternating, with consecutive requests at least 60 seconds apart.

## History windows

Every history query is capped at 72 hours for public requests. Coffee, Pro and
admin accounts get longer windows only where the query stays cheap:

| Query | Public | Paid |
|---|---|---|
| `busDelayHistory` | 72 hours | 90 days, daily beyond 7 days |
| `busStopStats` | 72 hours | 72 hours |
| `busJourneys`, `busJourneyStops` | 72 hours | 7 days |

The limits come from `EXPLAIN (ANALYZE, BUFFERS)` on a local TimescaleDB built
to production's volume, in October 2026. The public API reported a median of
about 293,000 counted predictions an hour, and a simulation of the collector's
histogram rule put that at roughly 200,000 histogram rows an hour across about
6,400 network, route and stop scopes. The dataset used 181,000 rows an hour
for 31 days
and a further 334 days for the measured scopes, with every other scope kept in
each chunk so segment counts matched. The archive held 58 days for the busiest
route at about 4,400 changed predictions an hour. Chunks older than the
production compression windows were compressed.

The local stop rankings took about four times as long as the same uncached
requests to production (6.3 s against 1.5 s for 24 hours, 18.8 s against
4.7 s for 72 hours), so the estimates below divide local times by four. The
busiest scope sets each limit, since anyone can open it.

| Query and scope | Window | Local | Production estimate |
|---|---|---|---|
| Delay history, network or busiest route | 7 days hourly | 1.8 s | 0.5 s |
| | 30 days daily | 2.7 s | 0.7 s |
| | 90 days daily | 8.6 s | 2 s |
| | 1 year daily | 34 s | 8 s |
| Delay history, median route or stop | 1 year daily | 2 to 4 s | under 1 s |
| Stop rankings, every stop | 72 hours | 18.8 s | 4.7 s measured |
| | 7 days | 39 s | 10 s |
| Journeys, busiest route | 7 days | 3.9 s | 1 s |
| | 30 days | 17 s | 4 s |

A year of delay history would exceed the 15-second statement timeout on the
local data, and stop rankings already cost seconds at 72 hours, so neither is
offered. Daily delay history refreshes every 15 minutes in the dashboard
rather than every minute. A daily continuous aggregate per scope would make a
year cheap if it is ever needed.

The archive keeps one chunk per hour indefinitely. A cutoff written as
`NOW() - interval` can't exclude chunks while planning, so a 24-hour journeys
query spent 9.7 s planning across 1,392 chunks, and a prepared statement's
sixth execution spent 9 s building a generic plan. History queries therefore
bind an absolute cutoff and run with `plan_cache_mode = force_custom_plan`,
which brought that planning down to about 50 ms.

## Published NTA performance

The NTA publishes route statistics for its PSO bus contracts on a
[public dashboard](https://www.nationaltransport.ie/public-transport-services/public-transport-contracts/operator-performance/pso-bus-performance-dashboard/pso-bus-performance-dashboard/).
`import_bus_performance.py` copies them into `bus_published_performance`, and
`/buses/published` shows them with search, contract and year filters and a
per-route trend. The bus history and route pages link to it.

These are reporting-period aggregates, not observations. Each record covers one
route in one contract for one of the NTA's 13 four-week periods. Low-frequency
routes report punctuality and departure counts, high-frequency routes report
excess passenger waiting time, and both report planned, operated and lost
kilometres. The NTA's punctuality window runs from one minute early to five
minutes 59 seconds late, so it is not comparable with the five-minute target
used for collected predictions. Nothing is written to the realtime tables or
`bus_delay_histogram`.

The importer reads three bulk tables from the dashboard's public
publish-to-web endpoint. It does not use the NTA realtime key or its request
budget. That endpoint is undocumented, so the importer refuses any response
whose columns, row layout, periods or metric ranges differ from what it
expects, and any truncated page. A failed run changes nothing. Missing metrics
stay null, and a period with no departures is not reported as 0% on time. The
EWT table labels the Bus Éireann DAC contract "Bus Éireann", which is mapped
back to "Bus Éireann DAC". The raw responses keep the original labels.

Each snapshot is identified by a hash of its normalised records. Replaying the
same snapshot inserts nothing. A changed snapshot is stored beside the earlier
ones and becomes the active one in the same transaction, so the page never
shows a partial import. Earlier snapshots stay in the database for comparison.

### Running an import

The import is manual. It reads no database credentials. It writes a SQL file
that you review and then apply.

1. Prepare the SQL on any machine with `requirements.txt` installed. Source
   responses are cached in the directory you give, and `--refresh` downloads a
   new snapshot instead of reusing them.

   ```bash
   python3 import_bus_performance.py \
     --directory ~/nta-published-cache \
     --refresh \
     --output /tmp/nta-published.sql
   ```

   It prints the record count, contracts and first and last periods. The first
   import in September 2026 had about 11,500 records for 443 route contracts,
   from 2024 P1. Stop if the numbers look wrong.

2. Apply it to production. Migration 018 creates the tables during deploy, so
   they already exist.

   ```bash
   docker exec -i irish_rail_db \
     psql -X -v ON_ERROR_STOP=1 -U irish_data -d ireland_public \
     < /tmp/nta-published.sql
   ```

   The file runs in one transaction with a 120-second timeout and checks its
   own record count before committing.

3. The page updates within five minutes, when the API cache expires.

To return to an earlier snapshot, change which row in `bus_published_imports`
has `is_active` set. At most one may be active.

### Tests

```bash
python3 -m unittest test_bus_performance_import
```

The database replay test runs only against a disposable Postgres container
that you name. It never reads `DATABASE_URL`.

```bash
docker run -d --name nta-published-test -e POSTGRES_PASSWORD=test postgres:18
BUS_PUBLISHED_TEST_CONTAINER=nta-published-test \
  python3 -m unittest test_bus_performance_import
docker rm -f nta-published-test
```

## Official references

- [GTFS `shapes.txt` reference](https://gtfs.org/documentation/schedule/reference/#shapestxt)
- [NTA GTFS dataset](https://data.gov.ie/dataset/nta-gtfs)
- [NTA GTFS-Realtime migration and ID guidance](https://www.nationaltransport.ie/news/attention-developers-upgrade-to-gtfs-realtime-api/)
- [NTA fair-usage policy](https://developer.nationaltransport.ie/usagepolicy)

## Persistent bulk archive and regional coverage

The database already stores the imported national schedule and current realtime
snapshots. API requests read that state rather than calling NTA for each visitor.
The bus collector keeps each successfully imported ZIP under
`BUS_GTFS_ARCHIVE_DIRECTORY/versions`, named by its content SHA-256. It also
atomically updates the latest copy for each configured source URL. Failed imports
leave those files alone. The complete ZIP retains
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
