# Architecture

Read this before changing ingestion, the database, or the public site. `main` is the trunk. This page is the longer map. [architecture.md](architecture.md) is the short one. Bus collection is in [buses.md](buses.md). Weather and traffic are in [context-data.md](context-data.md). After a fetch on 27 November 2026, `origin/dev` at `1b2681a` contains `origin/main` and is 13 commits ahead of it, including pull requests 120 and 121. New work still lands on `main`.

A claim names the file it comes from. A sentence that starts with Inference. is a conclusion from those files, not a line of code.

The live database was read on 27 November 2026, inside `BEGIN READ ONLY` with a 15 second statement timeout. Counts taken from `pg_class.reltuples` are planner estimates. Byte sizes of ordinary tables come from `pg_total_relation_size`. Chunk byte totals were not collected. `hypertable_size` and a sum of chunk sizes both hit the timeout.

## This branch and the running stack

This repository, on this branch, contains:

| Piece | Where |
| --- | --- |
| Rail collector | `daemon.py` |
| Schema on every daemon start | `docker-entrypoint.sh` applies `schema.sql`, then every file in `migrations/` |
| API | `api/src/main.rs` |
| Dashboard | `dashboard/src/App.tsx` |
| Local compose file | `docker-compose.yml` |
| Image build for the collector | `Dockerfile` |

The production compose file is `/home/semyon/server-stacks/irish-rail/stack.yaml`. It names `/home/semyon/code/owned/tools/irish-rail-nabber` as the build context. On 27 November 2026 that directory was checked out at `fix/bus-map-archive-regional` (`6039553`, 24 September 2026) with uncommitted edits. Those working-tree copies of `daemon.py` and `bus_daemon.py` do not match the running image. Leave that checkout alone.

Running containers on 27 November 2026, from `docker ps`:

| Container | Image | Role |
| --- | --- | --- |
| `irish_rail_db` | `timescale/timescaledb:2.25.2-pg18` | PostgreSQL 18.3, TimescaleDB 2.25.2, database `ireland_public` |
| `irish_rail_daemon` | `irish-rail-nabber-daemon:latest` | Rail collector, notices, weather, traffic |
| `irish_bus_daemon` | `irish-rail-nabber-daemon:latest` | GTFS and GTFS-RT, command `python bus_daemon.py` |
| `irish_rail_api` | `irish-rail-nabber-api:latest` | HTTP API |
| `irish_rail_dashboard` | `irish-rail-nabber-dashboard:latest` | nginx and the built UI |
| `irish_rail_cloudflared` | `cloudflare/cloudflared:2026.10.4` | Tunnel |

`Dockerfile` copies `requirements.txt`, `schema.sql`, `daemon.py`, `context_collector.py`, `bus_daemon.py`, `migrations/`, and `docker-entrypoint.sh`. The base image is `python:3.15-slim`. The running collector reports Python 3.15.2.

The running images are tagged `8048ab3`. That is this commit, `origin/main` at `8048ab396699ff43ddb086541097bd2765b8fd8b`, the merge of pull request 119. The API and dashboard images were built on 26 November 2026. The daemon image was built on 25 November 2026 and later carried the same tag. `daemon.py`, `bus_daemon.py`, `context_collector.py`, `schema.sql`, and `migrations/025_weather_and_traffic.sql` in the daemon image match this commit. Clerk lives in `api/src/auth/clerk.rs`. Polar billing lives in `api/src/billing/handlers.rs`. Migrations `001` through `025` are in `migrations/`.

Backups are not on `main` or `dev`. They are the cron job and the user timer under `/home/semyon/server-stacks/backups`.

## Data sources

### Irish Rail realtime API

`daemon.py` polls `http://api.irishrail.ie/realtime/realtime.asmx`. Field notes for that API are in [data-sources.md](data-sources.md).

This branch's collector calls these methods:

| Task name in `daemon.py` `run` | Upstream method | Interval |
| --- | --- | --- |
| `trains` | `getCurrentTrainsXML` | 5 seconds |
| `hacon` | `getHaconTrainsXML` | 5 seconds |
| `boards` | `getStationDataByCodeXML` | 5 seconds |
| `movements` | `getTrainMovementsXML` | 60 seconds |
| `stations` | `getAllStationsXML` | 86400 seconds |

`schema.sql` inserts `fetch_schedules` rows of 3 seconds for trains and station boards. The rail loop in `daemon.py` does not read that table. `bus_daemon.py` uses `fetch_schedules` to reserve the NTA realtime slot.

`daemon.py` polls `https://connect.irishrail.ie` for customer notices when `RAIL_NOTICES` is exactly `1`. Any other value turns the poll off. The default in that file is `"1"`. The variable was unset in the running container, so the poll is on. The homepage is scraped for an API key. That key is not written here.

### GTFS and GTFS-RT for buses

The bus collector is `bus_daemon.py`. Field notes and table names are in [buses.md](buses.md). The running container executes that file. `docker-compose.yml` defaults `NTA_GTFS_URL` to `GTFS_Realtime.zip` and stores zips on the `bus_gtfs_archives` volume. `stack.yaml` sets `GTFS_All.zip` and mounts `/home/semyon/data/irish-rail/bus-gtfs`. The running container uses the stack.yaml values.

Static GTFS comes from `NTA_GTFS_URL`. In the running container that is `https://www.transportforireland.ie/transitData/Data/GTFS_All.zip`. `stack.yaml` sets `BUS_STATIC_REFRESH_SECONDS` to 86400, and the container has that value. The daemon refreshes on startup, then on that interval, and writes zips under `BUS_GTFS_ARCHIVE_DIRECTORY`. The container value is `/app/bus-gtfs`, mounted from `/home/semyon/data/irish-rail/bus-gtfs` by `stack.yaml`. The `versions` directory holds one zip per feed hash. Two further zips sit in the parent directory.

`bus_daemon.py` keeps agencies, routes, trips, stop times, stops, and shapes for bus and coach route types. The feed source string in that file is `nta_gtfs`.

GTFS-RT uses the National Transport Authority JSON API. Defaults in `bus_daemon.py`:

| Feed | Default URL |
| --- | --- |
| Trip updates | `https://api.nationaltransport.ie/gtfsr/v2/gtfsr?format=json` |
| Vehicles | `https://api.nationaltransport.ie/gtfsr/v2/Vehicles?format=json` |
| Alerts | `https://api.nationaltransport.ie/gtfsr/v2/Alerts?format=json` |

The container's `NTA_TRIP_UPDATES_URL`, `NTA_VEHICLES_URL`, and `NTA_GTFSR_URL` are empty strings, so those defaults apply. `NTA_ALERTS_URL` is unset, so alerts use the default too. `NTA_API_KEY` is set. The value is not recorded here.

NTA allows one realtime request per 60 seconds. The bus daemon reserves the next slot in `fetch_schedules` under the endpoint `nta_realtime` before it calls the network, then alternates trip updates and vehicle positions. Alerts take a slot when the last `nta_alerts` fetch is older than 600 seconds. The reservation length is `BUS_REALTIME_INTERVAL_SECONDS` plus one safety second. The container interval is 60, so a successful reservation is 61 seconds apart. `MIN_REALTIME_INTERVAL_SECONDS` in that file is 60.

`docs/buses.md` also names `GTFS_Realtime.zip`. The running container uses `GTFS_All.zip` from `stack.yaml`.

### Weather and traffic

`context_collector.py` collects Met Éireann observations, the hourly climate archive, weather warnings, and TII traffic counters. See [context-data.md](context-data.md). `daemon.py` starts it when `CONTEXT_COLLECTION` is not `0`. `docker-compose.yml` defaults that variable to `1`. The variable was unset in the running container, so the same default applies. The live `weather_hourly` and `traffic_daily_class` tables hold data.

## Daemon schedule

### Rail daemon

`daemon.py` `run` starts every task below. `TYPE_MAP_REFRESH_INTERVAL` is 300 seconds. That refreshes the train-type map used while writing snapshots. It is not its own scheduled task. The running `irish_rail_daemon` image matches this commit for `daemon.py`.

| Task | Every | Work |
| --- | --- | --- |
| `trains` | 5 seconds | Live positions, content-hash dedup |
| `hacon` | 5 seconds | HACON feed, whole-response then per-train dedup |
| `boards` | 5 seconds | Station boards, 30 at a time (`STATION_FETCH_CONCURRENCY`) |
| `movements` | 60 seconds | Stop sequences for trains returned by `getCurrentTrainsXML` |
| `stations` | 86400 seconds | Station reference |
| `hash-cleanup` | 3600 seconds | Drop dedup hashes for trains that are no longer active |
| `history-rollups` | 300 seconds | Refresh `delay_history_hourly` for the last two hours |
| `fetch-history-retention` | 3600 seconds | `prune_fetch_history` deletes `fetch_history` older than 30 days, 50000 rows at a time |
| `alert-impacts` | 900 seconds | Notice impact rollups |
| `rail-segments` | 3600 seconds | Finished service days into segment and dwell totals, a few days per run |
| `service-alerts` | 120 seconds | `connect.irishrail.ie`, only when notices are enabled |
| `weather-live` | 1800 seconds | Met Éireann hourly observations |
| `weather-warnings` | 600 seconds | Met Éireann warnings |
| `weather-archive` | 600 seconds | One climate-archive station per run |
| `tii-sites` | 3600 seconds | TII site list, skipped when updated in the last day |
| `tii-weekly` | 3600 seconds | Seven-day count and speed profile |
| `tii-yearly` | 3600 seconds | Yearly AADT, sites rechecked after 7 days |
| `tii-bulk` | 3600 seconds | Bulk daily class counts |

`docs/scraper.md` used to list 10 second and 15 second polls. The `run` method does not. The upstream refresh notes in [data-sources.md](data-sources.md) are about the Irish Rail side, not this loop.

### Bus daemon

Intervals below are the defaults in `bus_daemon.py`. The running container can override them with `BUS_STATIC_REFRESH_SECONDS` and `BUS_REALTIME_INTERVAL_SECONDS`. Those two were 86400 and 60 on 27 November 2026.

| Task | Every | Work |
| --- | --- | --- |
| Static GTFS | 86400 seconds, and once at startup | Download, import, archive the zip |
| GTFS-RT | 61 seconds | One of trip updates, vehicles, or alerts |
| Working-table cleanup | 300 seconds, after an initial delay | Expire live rows and drop retired timetables |

`BUS_WRITE_LEGACY_STOP_UPDATES` is `0` in `stack.yaml` and in the container. The cleanup task returns immediately if `bus_stop_updates` still exists. That table was not in the public table list on 27 November 2026, so the cleanup body runs.

## Postgres schema

Database name `ireland_public`. User `irish_data`. Both are in `docker-compose.yml` and in `stack.yaml`. The password is not copied here.

TimescaleDB is enabled by `schema.sql`. Live server version is PostgreSQL 18.3 with TimescaleDB 2.25.2.

### Tables this repository defines

`schema.sql` creates the rail tables. Migrations `001` through `008` add columns, drop indexes, add accounts, add HACON, add API usage, add query indexes, and add `delay_history_hourly`. Migrations `009` through `025` add Clerk, Polar, the bus tables, alerts, segment rollups, and the weather and traffic tables. Those definitions are in `migrations/`. The sizes further down were read from the live database. They are not a second schema.

| Table | Kind in this branch | Role |
| --- | --- | --- |
| `stations` | ordinary, primary key `station_code` | Station reference. Live `count(*)` is 171 |
| `train_snapshots` | hypertable on `fetched_at` | Positions from `getCurrentTrainsXML` |
| `station_events` | hypertable on `fetched_at` | Board rows from `getStationDataByCodeXML` |
| `train_movements` | hypertable on `fetched_at` | Stops from `getTrainMovementsXML` |
| `train_snapshots_hacon` | hypertable on `fetched_at` | `migrations/005_add_hacon_snapshots.sql` |
| `fetch_history` | ordinary | One row per upstream call |
| `fetch_schedules` | ordinary | Seeded in `schema.sql`. The rail loop does not read it. `bus_daemon.py` reserves the NTA slot in it |
| `delay_history_hourly` | ordinary | Hourly delay rollup. `migrations/008_delay_history_rollups.sql` |
| `hourly_delays` | continuous aggregate | From `station_events`, refreshed every 5 minutes in `schema.sql` |
| `users`, `refresh_tokens` | ordinary | `migrations/004_add_users_and_auth.sql`. Roles `free`, `coffee`, `pro`, `admin` |
| `api_daily_usage` | ordinary | `migrations/006_add_api_daily_usage.sql` |

`schema.sql` and migration `005` first schedule compression after 7 days with a 7 day chunk interval. `migrations/019_train_compression.sql` then sets a 1 day chunk interval and a 2 day compression policy. There is no `add_retention_policy` in this repository. The live jobs match migration 019.

`latest_train_positions` and `latest_station_events` are views in `schema.sql`.

### Live measurements

Public tables were listed from `pg_class` on 27 November 2026. Hypertables were listed from `timescaledb_information.hypertables`. Jobs were listed from `timescaledb_information.jobs`.

Rail hypertable compression state on 27 November 2026. The row figures are `reltuples` on the three uncompressed chunks only, covering 25 November through 28 November. The 26 compressed chunks, from 28 May through 25 November, have no positive `reltuples`. For `train_snapshots`, 19 of those compressed chunks are 0 and 7 are negative. They are not included below. These figures are not the size of the hypertable.

| Hypertable | Chunks | Compressed chunks | Uncompressed estimated rows |
| --- | --- | --- | --- |
| `train_snapshots` | 29 | 26 | 1.08 million |
| `train_movements` | 29 | 26 | 0.85 million |
| `station_events` | 29 | 26 | 0.61 million |
| `train_snapshots_hacon` | 29 | 26 | 62 thousand |

The parent `pg_total_relation_size` of those four tables is a few dozen kilobytes. The rows are in chunks. Inference. Do not use the parent size as the table size.

Live compression jobs for those four tables use `compress_after` of 2 days and run every 12 hours, which is what migration 019 asks for.

`hourly_delays` still exists. Its refresh job matches `schema.sql`: start offset 3 hours, end offset 1 minute, every 5 minutes.

`users` on the live database has the Stripe columns from migration `004`, plus `clerk_user_id`, `polar_customer_id`, `polar_subscription_id`, and `polar_state_updated_at`. Those four come from `migrations/009_clerk_auth.sql` and `migrations/010_polar_billing.sql`.

`fetch_schedules` on the live database has the three Irish Rail rows from `schema.sql`, still at 3 seconds, plus `nta_realtime` at 60 seconds, `nta_trip_updates` at 60 seconds, and `nta_realtime_retention` at 86400 seconds with `enabled` false. The bus daemon writes `nta_realtime`.

`fetch_history` is an ordinary table of about 1.5 GB and about 1.7 million estimated rows. `prune_fetch_history` in `daemon.py` deletes rows older than 30 days, 50000 at a time, every 3600 seconds.

Live sizes on 27 November 2026 for tables created by migrations `009` through `025`. Ordinary-table sizes are `pg_total_relation_size` of the parent. Hypertable chunk bytes were not measured.

| Group | Tables | Size notes from 27 November 2026 |
| --- | --- | --- |
| Bus timetable | `bus_agencies`, `bus_routes`, `bus_trips`, `bus_stops`, `bus_stop_times`, `bus_shape_points`, `transit_feed_versions` | `bus_stop_times` 5.4 GB, `bus_trips` 3.4 GB, `bus_shape_points` 2.8 GB, `bus_stops` 189 MB |
| Bus working set | `bus_delay_samples`, `bus_trip_update_freshness`, `bus_stop_live`, `bus_vehicle_positions` | `bus_delay_samples` 12 GB. Freshness about 1.0 GB |
| Bus archive hypertables | `bus_stop_observations`, `bus_vehicle_observations`, `bus_trip_observations`, and the matching `*_legacy` hypertables | Current archive chunks are mostly compressed. Legacy tables still have more than a thousand chunks each |
| Bus rollups | `bus_segment_delay_hourly`, `bus_published_performance`, `bus_delay_histogram` | Segment rollup about 81 MB |
| Rail extras | `rail_service_alerts`, `rail_segment_delay_hourly`, `rail_dwell_delay_hourly`, `rail_segment_rollup_days` | Segment rollup about 80 MB |
| Context | `weather_hourly`, `weather_stations`, `weather_warnings`, `weather_archive_progress`, `traffic_sites`, `traffic_site_weekly`, `traffic_site_yearly`, `traffic_daily_class`, `traffic_bulk_days` | `weather_hourly` 373 MB. `traffic_daily_class` 286 MB |
| Billing | `billing_webhook_events` | Empty parent, 16 KB |

`migrations/009` through `migrations/025` cover Clerk, Polar, the bus schema, shapes, archive tables, working tables, legacy retirement, histograms, published performance, the 2 day rail compression, archive hash compaction, vacuum, rail and bus alerts, segment delay, and weather and traffic. The running image has the same files.

## Dedup, archive, and compaction

### Rail dedup in this branch

Hashes are MD5 via `stable_hash`. `_TIMESTAMP_RE` strips `<Servertime>` and `<Querytime>` in one place, the station-board hash in `fetch_all_station_boards`. The other hashes do not use it.

| Layer | What is hashed | Function |
| --- | --- | --- |
| Whole train list | Sorted `code:lat:lon` strings. A status or message change alone does not count | `fetch_trains` |
| Whole HACON response, then each train | The raw response, then a per-train fingerprint | `fetch_hacon` |
| One station board | Board XML after the timestamp strip | `fetch_all_station_boards` |
| One train at one station | Status, lateness, last location, and expected arrival and departure. Due-in is stored and is not in the fingerprint | `_insert_station_events` |
| One journey | Stops for a `train_code` and `train_date` | `_fetch_train_movements` |

`cleanup_stale_hashes` drops memory of journeys and station rows whose trains are no longer in the active set. It does not delete database rows.

Coordinates outside Ireland, and the upstream `0,0` pair, are stored as NULL by `to_irish_coordinate_pair`. `normalize_late_minutes` drops delays whose absolute value is over 720 minutes, and large negative delays that look like a midnight wrap.

### Bus archive and expiry

`bus_daemon.py` skips a realtime stop update when its state hash is unchanged. The comment there says unchanged states were about three quarters of archived rows before that filter. The same file compacts `update_hash` to the first 8 bytes of the SHA-256, stored as a bigint, when the column already has that type.

`migrations/014_bus_observation_archive.sql` creates `bus_stop_observations`, `bus_vehicle_observations`, and `bus_trip_observations`, and compresses them after 3 hours. Live jobs for the first three current archive hypertables use `compress_after` of 3 hours and run every 30 minutes. `bus_delay_histogram` compresses after 7 days.

`migrations/020_bus_archive_compaction.sql` converts `update_hash` from text to bigint only while the archive table is empty. If the table already has rows, the comment says `scripts/compact_bus_archive.py` rebuilds it. That script is in this repository. It is not copied into `/app` by `Dockerfile`. The same migration sets `compress_chunk_time_interval` to 1 day when the setting is still null.

The bus cleanup task moves finished live stops into `bus_segment_delay_hourly`, then deletes `bus_delay_samples` and `bus_trip_update_freshness` for trips last seen more than 168 hours ago. A trip is deleted only when its final state is already in `bus_trip_observations`. Each pass is limited to 120 seconds and batches of 5000 trips. Retired timetable versions lose their `bus_stop_times` once no live trip still points at them. The import lock is `irish-rail-nabber:nta-static-feed`.

No Timescale drop-chunks job was listed for the data hypertables. The only retention job in `timescaledb_information.jobs` was the job-history policy. Row deletion that does exist is the daemon code above, not a Timescale retention policy.

## Backups

Two copies. Neither is the script in this repository.

### NAS, daily at 02:00

`/etc/cron.d/server-stacks-backups` runs `/home/semyon/server-stacks/backups/scripts/irish-rail-db-backup.sh daily` at 02:00. The script refuses to run unless `/mnt/media` is mounted. It checks the NAS restic repository first, then writes a custom-format `pg_dump` and a globals dump under `/mnt/media/backups/irish-rail/postgres/daily/`. Both files must be non-empty. `pg_restore --list` must accept the database dump. The script then asks the NAS worker to archive the raw tree and to delete only the raw files it has verified.

The repository layout and the restore rules are in `/home/semyon/server-stacks/docs/backup/IRISH_RAIL_REPOSITORY.md`. That page says the NAS repository has no automatic expiry. It also says a restore rehearsal must use a disposable database, never `ireland_public`.

### Backblaze B2, daily at 04:30

The user timer `irish-rail-offsite-backup.timer` fires at 04:30. It runs `/home/semyon/server-stacks/backups/scripts/irish-rail-offsite-backup.sh`. The script mirrors `/home/semyon/data/irish-rail/bus-gtfs` onto the NAS, copies the newest `daily` restic snapshot from the NAS repository to a B2 restic repository, and snapshots the GTFS mirror with the tag `gtfs`. It then forgets B2 snapshots using 14 daily, 8 weekly, 12 monthly, and 3 yearly copies. The script reads a restic password file and sources a separate env file for the B2 account. Neither value is copied here.

### What this repository still says

`backup-db.sh` writes hourly gzip dumps, keeps six, and writes a daily gzip dump. `docs/deployment.md` used to describe that script as the live cron. It is not the cron entry. `backup.sh` is a separate `pg_dump` custom-format helper and is also not the cron entry.

## API and UI

### This branch

`api/src/main.rs` listens on `0.0.0.0:8000`.

| Path | Method | Handler |
| --- | --- | --- |
| `/graphql` | GET | Playground |
| `/graphql` | POST | Query, after the rate limit |
| `/chat` | POST | `api/src/chat.rs`. 401 with no user, 403 for `free`, then the same rate limit |
| `/auth/config`, `/auth/session`, `/auth/me` | GET | `api/src/auth/handlers.rs`. There is no `/auth/login` route |
| `/billing/checkout`, `/billing/portal`, `/billing/limits`, `/billing/usage` | as routed | `api/src/billing/handlers.rs` |
| `/billing/webhook` | POST | Polar signature check in `api/src/billing/handlers.rs` |
| `/health` | GET | `ok` |

Identity is Clerk, in `api/src/auth/clerk.rs`. Billing calls Polar. The README states both. `api/src/main.rs` does not register `/auth/login`, `/auth/register`, `/auth/refresh`, or `/auth/logout`.

GraphQL queries are the merged object in `api/src/schema/mod.rs`. It includes `StationQuery`, `TrainQuery`, `AnalyticsQuery`, `BusQuery`, `BusHistoryQuery`, `BusLiveQuery`, `BusPublishedQuery`, and `InsightsQuery`.

`delay_history` and the other analytics fields call `ensure_premium`. The role must be `coffee`, `pro`, or `admin`. `delay_history` reads `delay_history_hourly`. `hours` of 0 means all retained buckets. Otherwise `hours` must be 1 to 8784. `bucket` must be `hour`, `day`, or `week`.

`dashboard/nginx.conf` proxies `/graphql`, `/auth/`, `/billing/`, and `/api/chat` to `http://api:8000`. `/api/chat` is rewritten to `/chat`. Everything else is the single-page app.

`dashboard/src/App.tsx` routes `/`, `/stations`, and the `/buses` pages without a paywall. `/login/*` and `/register/*` are the Clerk flows. `/analytics`, `/history`, and `/chat` use `ProtectedRoute` with `requirePaid`. `/insights` uses `requireAdmin`. `/account` uses `ProtectedRoute` with no role check.

The GraphQL client posts to `/graphql` with credentials. See `dashboard/src/graphql/client.ts`. `App.tsx` comments that Clerk walks multi-step flows under the login and register paths.

`docker-compose.yml` defines `db`, `migrate`, `daemon`, `bus-daemon`, `api`, `dashboard`, and `cloudflared`. The long-running daemons set `SKIP_DB_MIGRATIONS`. The one-off `migrate` service applies the schema.

### Running API and UI

`stack.yaml` does not publish the API port. The API and the dashboard share an `edge` network. The dashboard address on that network is `10.254.41.6`. `API_RATE_LIMIT_TRUSTED_PROXIES` is that address, so the API treats the dashboard nginx as its proxy.

The running API image is tagged `8048ab3`, the same commit as this file. Its binary contains the strings `Clerk` and `Polar`, and it does not contain `Stripe` or `/auth/login`. The running dashboard bundle contains `Clerk`, and it still ships `LoginPage` and `RegisterPage` chunks, which matches `App.tsx`.

`stack.yaml` sets `POLAR_CHECKOUT_ENABLED` from the environment, defaulting the compose substitution to `false`. Whether checkout is on depends on `stack.env`, which is not quoted here.

The public name in both compose files is `https://traein.semyon.ie`.

## Deploy

Production is not `docker compose up` from this repository.

`/home/semyon/server-stacks/irish-rail/README.md`, dated 12 September 2026, says to run a one-off daemon container so migrations apply, then start `daemon`, `api`, and `dashboard` with `--no-build`. That README still describes the PostgreSQL 18 volume repair as pending and the data as an anonymous volume. On 27 November 2026 the running `irish_rail_db` mounts the named volume `irish-rail-nabber_postgres_data` at `/var/lib/postgresql`, which is the path `stack.yaml` declares. Read both before recreating the database container. The README is behind the container.

`stack.yaml` and `docker-compose.yml` both define `migrate`, `daemon`, and `bus-daemon`. `stack.yaml` pins the dashboard to `10.254.41.6` on an `edge` network. The repo compose file does not. Both set `SKIP_DB_MIGRATIONS` on the long-running daemons.

`Jenkinsfile` checks out `main` and deploys with `STACK_DIR` set to `/home/semyon/server-stacks/irish-rail`. That is the directory that holds `stack.yaml`.

GitHub Actions, `.github/workflows/ci.yml`, runs on pull requests and on pushes to `main`. It checks and tests the Rust API, type-checks and builds the dashboard, and compiles the Python sources. It does not deploy.

## Where to add a feature

Start from `main`.

1. Poll rail data from `daemon.py`, or bus data from `bus_daemon.py`. Add the task in `run` next to the existing `schedule_task` calls. Station boards strip `<Servertime>` and `<Querytime>` before hashing. Train positions hash `code:lat:lon`. HACON hashes the raw response.
2. Store it in the next file under `migrations/`. The one-off `migrate` container applies `schema.sql` and then every file in that directory. The long-running daemons set `SKIP_DB_MIGRATIONS`. The live database already has `001` through `025`, so the next file is `026`.
3. Read it from a resolver under `api/src/schema/` and add the query object in `api/src/schema/mod.rs` if it is new. Clamp numeric arguments the way `api/src/schema/bounds.rs` does.
4. Show it from `dashboard/src` and add a route in `dashboard/src/App.tsx`. If the browser calls a new API prefix, add a `location` in `dashboard/nginx.conf`. The current proxy forwards GraphQL, auth, billing, and chat.

Do not point a new backup, restore, or compose change at `ireland_public` from a laptop script. The live writers are the cron script and the B2 timer above.
