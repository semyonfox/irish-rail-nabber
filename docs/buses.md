# Bus data

The bus collector adds NTA GTFS schedules, realtime trip updates and current vehicle positions beside the existing Irish Rail feed. It does not replace or rename the rail tables.

## Sources

| Data | URL | Access | Refresh |
|---|---|---|---|
| Full GTFS schedule | `https://www.transportforireland.ie/transitData/Data/GTFS_All.zip` | public | daily |
| TripUpdates | `https://api.nationaltransport.ie/gtfsr/v2/gtfsr?format=json` | `x-api-key` | alternating, normally about every two minutes |
| Vehicles | `https://api.nationaltransport.ie/gtfsr/v2/Vehicles?format=json` | `x-api-key` | alternating, normally about every two minutes |

The collector keeps only routes whose GTFS `route_type` is `3` or `11`, or the extended bus/coach types `200–209`, `700–716` and `800`, plus their agencies, trips, stops, stop times, predictions and vehicle positions. The NTA exposes trip updates and vehicle positions through separate operations, but its fair-usage policy permits only one realtime API request per token every 60 seconds. The collector therefore alternates the operations within one shared request budget. The default target is one request every 60.001 seconds, so each kind normally refreshes about every 120.002 seconds. The collector measures intervals from task start; slow processing can still delay a request. The database reservation remains the authority for the next permitted request.

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

bus_stop_observations / bus_vehicle_observations / bus_trip_observations
  └── permanent compressed observations from each poll

bus_route_poll_stats / bus_hourly_delays
  └── per-poll totals and hourly continuous aggregates

bus_realtime_feeds
  └── complete gzip-compressed public response bodies
```

GTFS schedule times use integer seconds since the start of the service day. This preserves valid values beyond `24:00:00`, which PostgreSQL `TIME` cannot represent.

## Runtime

`bus_daemon.py` performs two independent jobs:

1. Download and import the matching static feed when its SHA-256 changes.
2. Reserve one shared realtime request slot, then alternate TripUpdates and Vehicles. TripUpdates appends changed stop states and refreshes current trip presence. Vehicles replaces the current vehicle snapshot.

The static import still runs when `NTA_API_KEY` is empty. Realtime collection stays disabled until the key is present. The key is sent only in the `x-api-key` header and must never appear in logs.

The database-backed request reservation adds a one-millisecond safety margin and applies across restarts or concurrent collectors sharing the database. Both operations use the same reservation, so replicas cannot turn the alternating schedule into extra NTA requests. The API reads the resulting database state and serves it to every user without calling NTA again.

Differential feeds are rejected because absence only means removal in a full-dataset feed. TripUpdates changes only stop predictions and trip freshness; Vehicles changes only the vehicle snapshot. One operation never clears the other operation's data. Trip-level freshness lets boards retire removed or canceled trips without rewriting every unchanged stop prediction.

The current NTA archive contains about 6.6 million bus stop-time rows. Route, trip and stop metadata remains versioned so historical IDs can still be interpreted, but stop times and shape points for inactive versions are removed after the replacement feed activates. A historical feed is rehydrated from its archive before it can become active again. Changed stop predictions are retained for seven days by default and pruned at most once per day; the separate observation hypertables preserve positions, predictions and trip statuses without automatic expiry.

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

The list queries return an empty list before the first feed import. `busRealtimeStatus` reports the newest successful poll and separate `vehiclesLastSuccessAt` and `tripUpdatesLastSuccessAt` timestamps. The legacy `isLive` field means either feed succeeded in the last three minutes. The dashboard uses each feed's own timestamp, so working predictions cannot make stale positions appear live. Stops, boards, current vehicles, scheduled route shapes and up to 72 hours of route-delay history are public. Coffee, Pro and admin accounts may query the full seven-day retained window.

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
and there is one latest archive per configured source URL plus immutable content-addressed versions. The complete ZIP retains
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

The default is now NTA's [full operator timetable](https://www.transportforireland.ie/transitData/Data/GTFS_All.zip),
not the realtime-operators-only subset. The 14 September 2026 audit found 783 bus
routes across 103 agency records, compared with 382 routes in the old subset.
All 382 previous route IDs and all 171,045 previous trip IDs were present, with
identical trip-to-route and trip-to-shape assignments. This compatibility check is
required before replacing the realtime-matching schedule with another source.

The validated bus selection contained 13,746 stops, 190,426 trips, 6,827,493 stop
times and 5,929,824 shape points. The 21 rail/tram routes in the combined archive
are excluded from bus tables. This adds City Direct (including 410/411/412), Local
Link, Citylink, Aircoach and other published operators without one download per
operator: still one bulk schedule refresh per day. The archive includes calendars
and exceptions even though map geometry shows all imported route variants.

Full timetable coverage does not imply realtime coverage. Positions, cancellations
and delay statistics appear only when an operator reports them through the live
feed. No synthetic live data is created for timetable-only routes.

## What the dashboard updates

Positions and selected-stop boards poll our cached GraphQL API every 15 seconds.
The live map fetches shapes separately every 60 seconds so geometry queries cannot
hold up position rendering. The network page fetches up to 100 route-delay rows
every 60 seconds and shows the age of each route's latest update. Stop and network pages do not request vehicle coordinates or
shape points. These browser requests never consume additional NTA requests.
The API caches vehicles for 30 seconds and boards for 20 seconds, so checking
again does not guarantee a new upstream observation.

The map displays separate ages for the last successful vehicle and prediction
imports. A selected bus also shows its source timestamp, which may be older than
the import. A short 1.2-second transition follows the exact trip's `shapeId` between
two received positions. It never moves past the latest report. Missing geometry,
changed trips, stale data, backward progress, large offsets and implausible jumps
skip animation. Reduced-motion preferences disable it. This is a visual transition,
not a continuous GPS feed or a prediction of travel between polls.

Route performance is calculated from every archived stop prediction observation, grouped by feed version and route. Repeated predictions count on each poll. It is not an archive of verified
actual arrivals. The map's route count describes loaded paths, not national
coverage. Live geometry is capped at 100 shapes; scheduled fallback remains a
representative selection, so not every displayed bus necessarily has a loaded path.

## Bulk queries and backfill

NTA's two realtime operations already provide bulk snapshots. Route geometry,
stop names and scheduled times come from the matching static ZIP, imported on the
server. GraphQL clients can request `busVehicles`, `busLiveRouteShapes`,
`busStopBoard` and `busRouteDelays` in one operation within existing limits.
The dashboard separates expensive geometry from frequent positions to avoid waiting
for the slowest resolver before showing an update.

Example combined query, using the existing public limits:

```graphql
query BusSnapshot {
  busRealtimeStatus {
    vehiclesLastSuccessAt
    tripUpdatesLastSuccessAt
  }
  busVehicles(limit: 3000) {
    vehicleId
    routeId
    routeShortName
    headsign
    shapeId
    latitude
    longitude
    sourceTimestamp
    fetchedAt
  }
  busLiveRouteShapes(limit: 100) {
    routeId
    routeShortName
    shapeId
    points { latitude longitude sequence }
  }
  busRouteDelays(hours: 24, limit: 100) {
    routeId
    routeShortName
    operatorName
    avgDelaySeconds
    onTimePct
    sampleCount
    lastUpdated
  }
}
```

These are bounded results, not a full national export. `busStopBoard(stopId: "…")`
adds expected and scheduled departures plus per-stop delay seconds for a selected
stop. Route averages must not be presented as a particular bus's current delay.
Deploy the additive API fields before the updated dashboard.


There is no historical vehicle backfill job in this repository. Migration 013
archives observations going forward and preserves every distinct imported schedule
ZIP. It cannot recover realtime polls that were never retained. See the persistent
observations section below for the current storage and API contract.

NTA's [fair-usage policy](https://developer.nationaltransport.ie/usagepolicy), checked
14 September 2026, limits each token to one realtime request every 60 seconds.
This implementation retains the shared request budget for both feeds.

## Read-only production check, 14 September 2026

The deployed public API returned positions, live route shapes and route-delay
statistics. A small combined query took 20.0 seconds. Subsequent individual queries
for status, three positions, three shapes and three delay rows took 0.21–0.29 seconds.
Caching affects these measurements; they do not isolate the slow resolver or
benchmark the changes in this branch. Some 24-hour route averages were based on
updates from several hours earlier, which is why the network view now shows
per-route update ages. No collector settings or production data were changed.

## Persistent observations and bus history, migration 013

Migration `013_bus_history.sql` adds append-only Timescale hypertables without
changing the live tables' deduplication keys. On each successful bulk poll the
collector writes every accepted bus position, stop prediction and trip status,
including unchanged states. Live snapshot replacement and seven-day cleanup do
not delete observations. The new history has no automatic expiry, matching rail;
full observation and trip snapshots use hourly chunks and compress after three
hours. Route summaries and delay histograms compress after seven days.

`bus_realtime_feeds` also retains each complete public realtime response body as
gzip-compressed JSON, before parsing. It contains no request headers, API keys or
URLs. This preserves unsupported fields and failed-to-parse responses for future
reprocessing. Schedule storage keeps the latest ZIP per source and each distinct
successful ZIP in `versions/<content-sha256>.zip`, using hard links to avoid a
second copy of the latest ZIP. The existing volume must be writable and have room
for ongoing growth. Production stores versioned ZIPs on the NAS at
`/mnt/media/irish-rail/bus-gtfs`, mounted at `/app/bus-gtfs` in the bus collector.

Route totals are computed once per poll in `bus_route_poll_stats`, in the same
transaction as the predictions. `bus_hourly_delays` aggregates these small totals
and includes its unmaterialized tail. This avoids scanning all stop observations
for the current hour on each dashboard request. A retry with the exact same poll
timestamp cannot duplicate observations or route totals. Repeated states in later
polls are intentionally separate observations. Canceled/deleted trips and
skipped/no-data stops stay in the archive but do not enter delay calculations.
Within target means between 60 seconds early and 300 seconds late. Counts are
observations, not unique stops, journeys, or verified actual arrivals.

The collector uses one shared database reservation across both realtime operations.
The scheduler now measures intervals from task start, so processing no longer adds
a full extra interval after each poll. Each request still needs a successful
60.001-second reservation. Route searches, charts, map updates and user counts never
make additional calls to NTA. Both operations remain bulk requests. The published
[NTA policy](https://developer.nationaltransport.ie/usagepolicy) specifies one call
per token every 60 seconds, not an independent budget per operation.

New public GraphQL queries:

```graphql
busRoutes(search: String, routeId: String, feedVersionId: Int, limit: Int = 60)
busDelayHistory(routeId: String, stopId: String, feedVersionId: Int, hours: Int = 24, since: String)
busRouteStopDelays(routeId: String!, feedVersionId: Int!, limit: Int = 100)
busStopStats(hours: Int = 24, search: String, feedVersionId: Int, stopId: String, limit: Int = 100)
busJourneys(feedVersionId: Int!, routeId: String, tripInstanceKey: String, hours: Int = 24, limit: Int = 100)
busJourneyStops(feedVersionId: Int!, tripInstanceKey: String!, hours: Int = 72)
```

`busRoutes` searches the complete active schedule, including routes with no live
coverage, by number, destination, operator or ID. An explicit feed version resolves
older routes. Route-specific history requires that version to avoid mixing reused
IDs. Network history covers all recorded versions. Public history is limited to
72 hours; existing Coffee, Pro and admin roles can request up to one year, or
`hours: 0` for all recorded history in weekly buckets. Other ranges use hourly
buckets up to 30 days and daily buckets above that. Windows include the hour
containing the cutoff. Route stop delays expose at most 200 current predictions.
Trips canceled without any stop predictions are retained in the archive, but do
not produce rows in that stop-level board.

The dashboard adds `/buses/routes`, versioned route detail links and
`/buses/history`. Network rankings link to route details. Route details show
average/P95/max delay, early/late observation counts, target percentage, a history
chart, current stop predictions and searchable recorded journeys. Journey details
show the latest reported prediction at each stop, including subsequent trip
cancellations. Stop rankings link to versioned stop histories. History starts with the new collector; these
changes do not invent observations for past polls or backfill the old live tables.

Bus searches, map snapshots, shapes, stop boards, rankings and history persist in
IndexedDB as validated snapshots. Entries are scoped by query and variables;
history also separates user/access level. At most 64 snapshots remain, and entries
older than seven days are ignored. History refreshes send the last saved bucket
as `since`, replace the mutable tail, preserve earlier buckets and prune expired
periods. Live route tables and journey pages also persist locally. Cache failures
fall back to network requests.
Data from the previous route is hidden while the new route loads. Successful data
remains visible during refreshes and errors. Cached source timestamps still drive
freshness indicators; an old map snapshot never becomes live just because it was
read from disk. Shapes poll separately from positions, and rankings separately
from status. Hidden tabs skip polling, requests do not overlap, and GraphQL fetches
time out after 30 seconds. No new frontend dependencies were added.

Apply migrations before restarting the collector and API, then deploy the dashboard.
This changes long-term disk growth, including full gzip response bodies and schedule
versions. Monitor storage after deployment. The archive and totals are additive;
older application code can still use the existing live tables.

Checks include `python3 -m unittest test_bus_daemon.py`, `cargo test --all-targets`,
`vp check`, `vp test`, and `vp run build`. An opt-in integration test executes the
actual collector SQL against a disposable TimescaleDB 2.25.2 instance and checks
migration reruns, retries, state reversions, cancellations, version separation,
compression, raw response recovery and the new resolver SQL:

```bash
# Isolated test container only, no host port or production volumes.
docker run -d --name irish-rail-bus-history-test --network none \
  --tmpfs /var/lib/postgresql -e POSTGRES_HOST_AUTH_METHOD=trust \
  timescale/timescaledb:2.25.2-pg18
docker exec irish-rail-bus-history-test createdb -U postgres bus_history_test
BUS_HISTORY_TEST_CONTAINER=irish-rail-bus-history-test \
  python3 -m unittest test_bus_history_integration.py
docker rm -f irish-rail-bus-history-test
```


### Request timing and rate-limit responses

The default interval is 60.001 seconds between outgoing request attempts: the
published 60-second allowance plus one millisecond. Processing consumes that
interval instead of starting another full wait. The worker follows the database's
next-allowed deadline using a monotonic local clock. If it wakes just before a slot
opens, it waits the remaining fraction rather than skipping an entire interval.
Database round trips, OS scheduling and network latency can still make requests
later; millisecond precision at NTA's server is not guaranteed.

HTTP 429 does not trigger an immediate retry loop. The collector honors
`Retry-After`, supporting delay seconds and HTTP dates, without shortening the
existing shared reservation. Missing/invalid headers leave the normal deadline in
place. Cooldowns are persisted for other collectors and restarts. The next allowed
request retries the same operation, then returns to alternating feeds after a
successful response. Ordinary non-rate-limit failures continue alternating.


## Exact percentiles, migration 014

`bus_delay_histogram` stores observation counts for each delay value, hour,
schedule version and network/route/stop scope. The collector computes these once
per accepted poll in the observation transaction. `bus_histogram_polls` makes
retries idempotent. All-time charts can combine distributions without scanning
every raw observation or averaging per-hour P95 values. The weighted percentile
function is equivalent to PostgreSQL `percentile_cont` on the expanded samples.

The archive is permanent and still grows after compression. Monitor filesystem
space and `hypertable_detailed_size`; compression is not a storage capacity limit.
History begins with this deployment. Earlier mutable live records cannot recover
every historical poll.

Deployment verification on 14 September 2026: migrations 013/014 applied to the
existing database; daemon, bus-daemon, API and dashboard replaced using
`bus-parity-20260914` images. The database container and tunnel were not recreated.
Previous application images remain tagged `before-bus-parity-20260914`.
The public route search, P95 history, stop rankings and archived journey queries
returned real data. Both realtime operations completed successfully after rollout.
The source worktree remains uncommitted.

## Imported NTA performance history, migration 015

The public PSO dashboard supplies historical route-period aggregates. The initial
import contains 11,469 records for 443 route/contract combinations, covering
2024 P1 through 2026 P3 across seven contracts. Coverage varies by metric and
route. The source model was updated on 31 August 2026.

Records include low-frequency punctuality percentages and departure counts,
high-frequency excess passenger waiting time, and planned, operated, lost and
contractually deductible lost kilometres.

[Original NTA dashboard](https://www.nationaltransport.ie/public-transport-services/public-transport-contracts/operator-performance/pso-bus-performance-dashboard/pso-bus-performance-dashboard/)

The importer reads three bulk public tables from the report's publish-to-web
endpoint. It does not use the NTA realtime key or its request budget.
`import_bus_performance.py` validates column identities, compressed dictionary
rows, period formats, metric ranges, row limits and duplicate identities.
The EWT table's “Bus Éireann” label maps to “Bus Éireann DAC”, matching its
`EWT BE DAC` source entity. Raw responses preserve the original labels.

`bus_published_imports` stores source URL, refresh/import times and complete
gzip-compressed query responses. `bus_published_performance` stores the original
year/period, contract, route and reported metrics. Records are keyed by a hash of
the normalized snapshot. Replaying an unchanged snapshot inserts no duplicates.
Changed snapshots remain alongside earlier imports; activation is transactional.
These small published aggregates use ordinary PostgreSQL tables in the existing
TimescaleDB database, since they have no individual observation timestamps.

No synthetic positions, stop observations, P95 values or hourly delay buckets are
generated. NTA's published punctuality threshold is one minute early through five
minutes and 59 seconds late, distinct from our five-minute prediction target.
Missing metrics remain null; zero actual departures do not become 0% punctuality.

The public `/buses/published` page offers search, contract/year filters, route
charts and pagination, with IndexedDB caching. Bus history and route details
link to it. Source links and coverage remain visible. Published aggregates are
available without a history subscription.

Prepare an import without database credentials:

```bash
python3 import_bus_performance.py \
  --directory /path/to/public-source-cache \
  --output /tmp/nta-bus-backfill.sql
```

Use `--refresh` to download a new snapshot; otherwise downloaded files are reused.
Apply migration 015, then the prepared SQL with `psql -X -v ON_ERROR_STOP=1`.
The source cache and SQL contain public transport data only. The daemon image
includes the importer for future operator use.

The older Dublin GPS sources were checked but not imported. Both City Council
ZIP endpoints returned HTTP 400, and the catalogue API denied access to the
historical package. They are not required for this NTA backfill.

Validation covers source decoding, normalization, database replay and snapshot
activation, a complete import in isolated TimescaleDB, real GraphQL queries, and
browser checks for search, year filters, charts and offline reloads.

```bash
python3 -m unittest test_bus_performance_import
# With a disposable container named irish-rail-bus-backfill-test:
BUS_PUBLISHED_TEST_CONTAINER=irish-rail-bus-backfill-test \
  python3 -m unittest test_bus_performance_import
```

### Route and stop maps

Route detail pages draw the imported GTFS paths for all route variants and directions,
with scheduled stops as outlined dots and live buses when the vehicle feed is fresh.
Click a stop, or choose one from the accessible stop selector, to open its departures
and delay history. On the national map, clicking a path or bus loads and highlights
that route and its stops; route search is linked from the map summary.

`busRouteMap(routeId, feedVersionId)` returns one version's shapes and distinct scheduled
stops in one database-backed query. Omitting the version searches active feeds and
rejects ambiguous route IDs. Missing historical geometry stays unavailable rather
than substituting the current schedule. Paths retain their endpoints and at most
about 1,000 sampled coordinates per shape. The API caches results for 15 minutes;
the browser persists the validated geometry and stops in the existing IndexedDB
cache. Static map requests never call the NTA realtime API.

Map validation used route 409's real GTFS data: six variants, 2,208 original shape
points, 2,383 scheduled trips and 45 distinct stops. The test database was isolated
from production; only public timetable data was copied into it.

Browser checks verified the six route paths and 45 stop features, selection by map
click and keyboard-accessible stop selector, versioned stop links, saved-data reload
with the API unavailable, and mobile layout without horizontal overflow. Selecting
a path on the national map also expanded it to the full route geometry and stops.

### Stop-board query and map zoom limits

Stop boards first select candidates by the requested stop ID, with a separate
indexed timetable lookup for predictions that only identify a stop sequence.
This avoids joining national stop history to the full timetable before filtering.
Freshness, cancellation, skipped-stop and latest-prediction rules still apply.
The query uses a ten-second statement timeout and disables parallel workers within
its transaction to avoid exhausting PostgreSQL's container shared-memory space.
Run the regression fixture only against a disposable container:
`BUS_STOP_BOARD_TEST_CONTAINER=irish-rail-stop-board-test python3 -m unittest test_bus_stop_board_integration -v`
(the fixture database is named `bus_stop_test`).

The shared raster source has `maxzoom: 19`, matching OpenStreetMap's standard tile
coverage. Closer zoom levels reuse those tiles rather than requesting nonexistent
z20–z22 images. Route lines, buses and stop markers remain independently zoomable.

The full-feed edge-case audit found no duplicate route IDs or invalid stop
coordinates. Twenty-one short route numbers are shared by different services;
search retains them by route ID and displays operator/destination instead of
collapsing them by number. Route `2 374 c a` is listed by NTA but has no trips or
shape in the source: it remains searchable and reports missing geometry. Historical
route pages link to the current schedule after a feed version changes. Route search
also synchronizes its input when navigation changes the URL query.

Static refreshes now use a separate lock from realtime polls. Each poll pins one
feed version; reference route/trip/stop metadata remains available after a newer
version activates. A warm startup also begins live polling without waiting for
its schedule refresh. A cold startup still waits for the first usable schedule.
The concurrency regression test keeps a static download blocked while proving
that the realtime worker can acquire its lock and run, then checks clean shutdown.

Feed activation refreshes planner statistics for the static bus tables in the same
transaction, including unchanged-feed activation. This prevents the first route
map queries from using the retired feed's distributions after a large import.
The refresh was checked with PostgreSQL 18 and pending deferred foreign-key checks.
The live-poll regression also switches the active feed during a response and verifies
that the archive and normalized rows retain the poll's original version; the next
poll uses the newly active version.
