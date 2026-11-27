# Architecture

Read this before changing ingestion, the database, or the public site. Two trees are easy to mix up. This branch tracks `origin/dev` and stops at the rail collector, the Stripe API, and migrations `001` to `008`. The containers that are actually running were built from a later tree. That tree is not in this branch.

A claim names the file it comes from. A sentence that starts with Inference. is a conclusion from those files, not a line of code.

The live database was read on 27 November 2026, inside `BEGIN READ ONLY` with a 15 second statement timeout. Counts taken from `pg_class.reltuples` are planner estimates. Byte sizes of ordinary tables come from `pg_total_relation_size`. Chunk byte totals were not collected. `hypertable_size` and a sum of chunk sizes both hit the timeout.

## This branch and the running stack

This repository, on this branch, contains:

| Piece | Where |
| --- | --- |
| Rail collector | `daemon.py` |
| Schema applied on first boot | `schema.sql`, then `migrations/*.sql` via `docker-entrypoint.sh` |
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

`Dockerfile` on this branch copies only `daemon.py` and installs `python:3.14-slim`. The running collector reports Python 3.15.2 and has `/app/bus_daemon.py`, `/app/context_collector.py`, and migrations through `025_weather_and_traffic.sql`.

The running images are tagged `8048ab3`. That tag is `origin/main` at `8048ab396699ff43ddb086541097bd2765b8fd8b`, the merge of pull request 119 on 26 November 2026. The API image and the dashboard image were built that day. The daemon image was built on 25 November 2026 and later carried the same tag. `daemon.py`, `bus_daemon.py`, `context_collector.py`, `schema.sql`, and `migrations/025_weather_and_traffic.sql` in the daemon image match `origin/main` at `8048ab3`. They also match `main` at `0866715`, the 25 November merge of pull request 114, because those files did not change between the two commits. They do not match `origin/dev` at `495f7ac`. `origin/main` contains `api/src/auth/clerk.rs`. `origin/dev` does not.

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

`schema.sql` inserts `fetch_schedules` rows of 3 seconds for trains and station boards. No other file in this branch reads that table. The loop above is what runs.

The running rail container starts the same five intervals, read from `/app/daemon.py` inside `irish_rail_daemon`. It also starts tasks this branch does not have. See the schedule table below.

The same running file polls `https://connect.irishrail.ie` for customer notices when `RAIL_NOTICES` is not `0`. The variable was unset in the container, so the default in that file applies and the poll is on. The homepage is scraped for an API key. That key is not written here.

### GTFS and GTFS-RT for buses

There is no bus collector in this branch. The running bus container executes `/app/bus_daemon.py`.

Static GTFS comes from `NTA_GTFS_URL`. In the running container that is `https://www.transportforireland.ie/transitData/Data/GTFS_All.zip`. `stack.yaml` sets `BUS_STATIC_REFRESH_SECONDS` to 86400, and the container has that value. The daemon refreshes on startup, then on that interval, and writes zips under `BUS_GTFS_ARCHIVE_DIRECTORY`. The container value is `/app/bus-gtfs`, mounted from `/home/semyon/data/irish-rail/bus-gtfs` by `stack.yaml`. The `versions` directory holds one zip per feed hash. Two further zips sit in the parent directory.

`bus_daemon.py` keeps agencies, routes, trips, stop times, stops, and shapes for bus and coach route types. The feed source string in that file is `nta_gtfs`.

GTFS-RT uses the National Transport Authority JSON API. Defaults in `/app/bus_daemon.py`:

| Feed | Default URL |
| --- | --- |
| Trip updates | `https://api.nationaltransport.ie/gtfsr/v2/gtfsr?format=json` |
| Vehicles | `https://api.nationaltransport.ie/gtfsr/v2/Vehicles?format=json` |
| Alerts | `https://api.nationaltransport.ie/gtfsr/v2/Alerts?format=json` |

The container's `NTA_TRIP_UPDATES_URL`, `NTA_VEHICLES_URL`, and `NTA_GTFSR_URL` are empty strings, so those defaults apply. `NTA_ALERTS_URL` is unset, so alerts use the default too. `NTA_API_KEY` is set. The value is not recorded here.

NTA allows one realtime request per 60 seconds. The bus daemon reserves the next slot in `fetch_schedules` under the endpoint `nta_realtime` before it calls the network, then alternates trip updates and vehicle positions. Alerts take a slot when the last `nta_alerts` fetch is older than 600 seconds. The reservation length is `BUS_REALTIME_INTERVAL_SECONDS` plus one safety second. The container interval is 60, so a successful reservation is 61 seconds apart. `MIN_REALTIME_INTERVAL_SECONDS` in that file is 60.

`stack.env.example` names `GTFS_Realtime.zip` as the static URL. The running container uses `GTFS_All.zip`, which is also the URL written in `stack.yaml`.

### Weather and traffic

`/app/context_collector.py` in the rail container documents its sources. Met Éireann live observations, the hourly climate archive, and weather warnings. TII traffic counters and a bulk daily file. The rail daemon constructs that collector when `CONTEXT_COLLECTION` is not `0`. That variable was unset in the container, so the default in `/app/daemon.py` applies. The live `weather_hourly` and `traffic_daily_class` tables hold data, which matches a collector that has been running.

This branch has none of that code.

## Daemon schedule

### This branch, `daemon.py`

| Task | Every | Work |
| --- | --- | --- |
| `trains` | 5 seconds | Live positions, content-hash dedup |
| `hacon` | 5 seconds | HACON feed, whole-response then per-train dedup |
| `boards` | 5 seconds | Station boards, 30 at a time (`STATION_FETCH_CONCURRENCY`) |
| `movements` | 60 seconds | Stop sequences for trains seen on the board |
| `stations` | 86400 seconds | Station reference |
| `hash-cleanup` | 3600 seconds | Drop dedup hashes for trains that are no longer active |
| `history-rollups` | 300 seconds | Refresh `delay_history_hourly` for the last two hours |

`TYPE_MAP_REFRESH_INTERVAL` is 300 seconds. That refreshes the train-type map used while writing snapshots. It is not its own scheduled task.

`docs/scraper.md` used to list 10 second and 15 second polls. The `run` method does not. The upstream refresh notes in [data-sources.md](data-sources.md) are about the Irish Rail side, not this loop.

### Running rail container, extra tasks

Read from `/app/daemon.py` in `irish_rail_daemon`. The five rail polls and the three maintenance tasks above are also present there.

| Task | Every | Work |
| --- | --- | --- |
| `fetch-history-retention` | 3600 seconds | Delete `fetch_history` older than 30 days, 50000 rows at a time |
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

### Running bus container

Read from `/app/bus_daemon.py` in `irish_bus_daemon`, with the container environment above.

| Task | Every | Work |
| --- | --- | --- |
| Static GTFS | 86400 seconds, and once at startup | Download, import, archive the zip |
| GTFS-RT | 61 seconds | One of trip updates, vehicles, or alerts |
| Working-table cleanup | 300 seconds, after an initial delay | Expire live rows and drop retired timetables |

`BUS_WRITE_LEGACY_STOP_UPDATES` is `0` in `stack.yaml` and in the container. The cleanup task returns immediately if `bus_stop_updates` still exists. That table was not in the public table list on 27 November 2026, so the cleanup body runs.

## Postgres schema

Database name `ireland_public`. User `irish_data`. Both are in `docker-compose.yml` and in `stack.yaml`. The password is not copied here.

TimescaleDB is enabled by `schema.sql`. Live server version is PostgreSQL 18.3 with TimescaleDB 2.25.2.

### Tables this branch defines

`schema.sql` creates the rail tables. Later migrations add columns, drop indexes, add accounts, add HACON, add API usage, add query indexes, and add `delay_history_hourly`.

| Table | Kind in this branch | Role |
| --- | --- | --- |
| `stations` | ordinary, primary key `station_code` | Station reference. Live `count(*)` is 171 |
| `train_snapshots` | hypertable on `fetched_at` | Positions from `getCurrentTrainsXML` |
| `station_events` | hypertable on `fetched_at` | Board rows from `getStationDataByCodeXML` |
| `train_movements` | hypertable on `fetched_at` | Stops from `getTrainMovementsXML` |
| `train_snapshots_hacon` | hypertable on `fetched_at` | `migrations/005_add_hacon_snapshots.sql` |
| `fetch_history` | ordinary | One row per upstream call |
| `fetch_schedules` | ordinary | Seeded in `schema.sql`. Unused by this branch's daemon |
| `delay_history_hourly` | ordinary | Hourly delay rollup. `migrations/008_delay_history_rollups.sql` |
| `hourly_delays` | continuous aggregate | From `station_events`, refreshed every 5 minutes in `schema.sql` |
| `users`, `refresh_tokens` | ordinary | `migrations/004_add_users_and_auth.sql`. Roles `free`, `coffee`, `pro`, `admin` |
| `api_daily_usage` | ordinary | `migrations/006_add_api_daily_usage.sql` |

`schema.sql` and migration `005` compress the rail hypertables after 7 days and set `compress_chunk_time_interval` to 7 days. There is no `add_retention_policy` in this branch. `docs/scraper.md` already says that.

`latest_train_positions` and `latest_station_events` are views in `schema.sql`.

### What is live, and where it drifts

Public tables were listed from `pg_class` on 27 November 2026. Hypertables were listed from `timescaledb_information.hypertables`. Jobs were listed from `timescaledb_information.jobs`.

Rail hypertable estimates and compression state:

| Hypertable | Chunks | Compressed chunks | Estimated rows |
| --- | --- | --- | --- |
| `train_snapshots` | 29 | 26 | 1.1 million |
| `train_movements` | 29 | 26 | 0.84 million |
| `station_events` | 29 | 26 | 0.61 million |
| `train_snapshots_hacon` | 29 | 26 | 61 thousand |

The parent `pg_total_relation_size` of those four tables is a few dozen kilobytes. The rows are in chunks. Inference. Do not use the parent size as the table size.

Live compression jobs for those four tables use `compress_after` of 2 days and run every 12 hours. Image migration `/app/migrations/019_train_compression.sql` sets a 1 day chunk interval and replaces the policy with 2 days when the current policy differs. That file is not in this branch. `schema.sql` still says 7 days. The live jobs match migration 019, not `schema.sql`.

`hourly_delays` still exists. Its refresh job matches `schema.sql`: start offset 3 hours, end offset 1 minute, every 5 minutes. A second continuous aggregate, `bus_hourly_delays`, exists only on the live database. Its refresh job uses a 3 day start offset and no end offset.

`users` on the live database has the Stripe columns from migration `004`, plus `clerk_user_id`, `polar_customer_id`, `polar_subscription_id`, and `polar_state_updated_at`. Those four are not in this branch. Image migrations `009_clerk_auth.sql` and `010_polar_billing.sql` are the likely source. Inference. The column names match those filenames, and the SQL files were not copied out in full.

`fetch_schedules` on the live database has the three Irish Rail rows from `schema.sql`, still at 3 seconds, plus `nta_realtime` at 60 seconds, `nta_trip_updates` at 60 seconds, and `nta_realtime_retention` at 86400 seconds with `enabled` false. The bus daemon writes `nta_realtime`.

`fetch_history` is an ordinary table of about 1.5 GB and about 1.7 million estimated rows. The running rail daemon deletes rows older than 30 days. This branch's `daemon.py` does not.

Other live tables that this branch does not create, with ordinary-table sizes where the parent relation is the data:

| Group | Tables | Size notes from 27 November 2026 |
| --- | --- | --- |
| Bus timetable | `bus_agencies`, `bus_routes`, `bus_trips`, `bus_stops`, `bus_stop_times`, `bus_shape_points`, `transit_feed_versions` | `bus_stop_times` 5.4 GB, `bus_trips` 3.4 GB, `bus_shape_points` 2.8 GB, `bus_stops` 189 MB |
| Bus working set | `bus_delay_samples`, `bus_trip_update_freshness`, `bus_stop_live`, `bus_vehicle_positions` | `bus_delay_samples` 12 GB. Freshness about 1.0 GB |
| Bus archive hypertables | `bus_stop_observations`, `bus_vehicle_observations`, `bus_trip_observations`, and the matching `*_legacy` hypertables | Current archive chunks are mostly compressed. Legacy tables still have more than a thousand chunks each |
| Bus rollups | `bus_segment_delay_hourly`, `bus_published_performance`, `bus_delay_histogram`, `bus_route_poll_stats`, `bus_hourly_delays` | Segment rollup about 81 MB |
| Rail extras | `rail_service_alerts`, `rail_segment_delay_hourly`, `rail_dwell_delay_hourly`, `rail_segment_rollup_days` | Segment rollup about 80 MB |
| Context | `weather_hourly`, `weather_stations`, `weather_warnings`, `weather_archive_progress`, `traffic_sites`, `traffic_site_weekly`, `traffic_site_yearly`, `traffic_daily_class`, `traffic_bulk_days` | `weather_hourly` 373 MB. `traffic_daily_class` 286 MB |
| Billing | `billing_webhook_events` | Empty parent, 16 KB |

Image migrations `011` through `025` are present under `/app/migrations` and absent from `migrations/` here. They cover Clerk, Polar, the bus schema, shapes, archive tables, working tables, legacy retirement, histograms, published performance, the 2 day rail compression, archive hash compaction, vacuum, rail and bus alerts, segment delay, and weather and traffic.

## Dedup, archive, and compaction

### Rail dedup in this branch

`daemon.py` strips `<Servertime>` and `<Querytime>` with `_TIMESTAMP_RE` before hashing. Those tags change on every response. The hash is MD5.

| Layer | What is hashed | Function |
| --- | --- | --- |
| Whole train list | Cleaned current-trains XML | `fetch_trains` |
| Whole HACON response, then each train | Cleaned HACON XML, then a per-train fingerprint | `fetch_hacon` |
| One station board | Cleaned board XML | `fetch_all_station_boards` |
| One train at one station | Status, lateness, location, due-in, expected times | `_insert_station_events` |
| One journey | Stops for a `train_code` and `train_date` | `_fetch_train_movements` |

`cleanup_stale_hashes` drops memory of journeys and station rows whose trains are no longer in the active set. It does not delete database rows.

Coordinates outside Ireland, and the upstream `0,0` pair, are stored as NULL by `to_irish_coordinate_pair`. `normalize_late_minutes` drops delays whose absolute value is over 720 minutes, and large negative delays that look like a midnight wrap.

### Bus archive and expiry, running image only

`/app/bus_daemon.py` skips a realtime stop update when its state hash is unchanged. The comment there says unchanged states were about three quarters of archived rows before that filter. The same file compacts `update_hash` to the first 8 bytes of the SHA-256, stored as a bigint, when the column already has that type.

Image migration `014_bus_observation_archive.sql` creates `bus_stop_observations`, `bus_vehicle_observations`, and `bus_trip_observations`, and compresses them after 3 hours. Live jobs for the first three current archive hypertables use `compress_after` of 3 hours and run every 30 minutes. `bus_delay_histogram` and `bus_route_poll_stats` compress after 7 days.

Image migration `020_bus_archive_compaction.sql` converts `update_hash` from text to bigint only while the archive table is empty. If the table already has rows, the comment says `scripts/compact_bus_archive.py` rebuilds it. That script is not in `/app` and not in this branch. The same migration sets `compress_chunk_time_interval` to 1 day when the setting is still null.

The bus cleanup task moves finished live stops into `bus_segment_delay_hourly`, then deletes `bus_delay_samples` and `bus_trip_update_freshness` for trips last seen more than 168 hours ago. A trip is deleted only when its final state is already in `bus_trip_observations`. Each pass is limited to 120 seconds and batches of 5000 trips. Retired timetable versions lose their `bus_stop_times` once no live trip still points at them. The import lock is `irish-rail-nabber:nta-static-feed`.

No Timescale drop-chunks job was listed for the data hypertables. The only retention job in `timescaledb_information.jobs` was the job-history policy. Row deletion that does exist is the daemon code above, not a Timescale retention policy.

## Backups

Two copies. Neither is the script in this repository.

### NAS, daily at 02:00

`/etc/cron.d/server-stacks-backups` runs `/home/semyon/server-stacks/backups/scripts/irish-rail-db-backup.sh daily` at 02:00. The script refuses to run unless `/mnt/media` is mounted. It checks the NAS restic repository first, then writes a custom-format `pg_dump` and a globals dump under `/mnt/media/backups/irish-rail/postgres/daily/`. Both files must be non-empty. `pg_restore --list` must accept the database dump. The script then asks the NAS worker to archive the raw tree and to delete only the raw files it has verified.

The repository layout and the restore rules are in `/home/semyon/server-stacks/docs/backup/IRISH_RAIL_REPOSITORY.md`. That page says the NAS repository has no automatic expiry. It also says a restore rehearsal must use a disposable database, never `ireland_public`.

### Backblaze B2, daily at 04:30

The user timer `irish-rail-offsite-backup.timer` fires at 04:30. It runs `/home/semyon/server-stacks/backups/scripts/irish-rail-offsite-backup.sh`. The script mirrors `/home/semyon/data/irish-rail/bus-gtfs` onto the NAS, copies the newest `daily` restic snapshot from the NAS repository to a B2 restic repository, and snapshots the GTFS mirror with the tag `gtfs`. It then forgets B2 snapshots using 14 daily, 8 weekly, 12 monthly, and 3 yearly copies. Credentials stay in the restic password files named by that script. They are not copied here.

### What this repository still says

`backup-db.sh` writes hourly gzip dumps, keeps six, and writes a daily gzip dump. `docs/deployment.md` used to describe that script as the live cron. It is not the cron entry. `backup.sh` is a separate `pg_dump` custom-format helper and is also not the cron entry.

## API and UI

### This branch

`api/src/main.rs` listens on `0.0.0.0:8000`.

| Path | Method | Handler |
| --- | --- | --- |
| `/graphql` | GET | Playground |
| `/graphql` | POST | Query, after the rate limit |
| `/chat` | POST | `api/src/chat.rs`, same rate limit |
| `/auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/session`, `/auth/me` | as routed | `api/src/auth/handlers.rs` |
| `/billing/checkout`, `/billing/portal`, `/billing/limits`, `/billing/usage` | as routed | `api/src/billing/handlers.rs` |
| `/billing/webhook` | POST | Stripe signature check in that same file |
| `/health` | GET | `ok` |

Auth is a JWT access cookie plus opaque refresh tokens. Billing calls Stripe. There is no Clerk and no Polar code under `api/src` on this branch.

GraphQL queries are the merged object in `api/src/schema/mod.rs`.

| Module | Fields |
| --- | --- |
| `api/src/schema/station.rs` | `stations`, `station`, `station_board`, `country_board` |
| `api/src/schema/train.rs` | `live_trains`, `train_journey`, `train_history`, `route_segments` |
| `api/src/schema/analytics.rs` | `delay_history`, `hourly_delays`, `station_delay_stats`, `network_summary`, `route_reliability`, `fetch_status` |

`delay_history` and the other analytics fields call `ensure_premium`. The role must be `coffee`, `pro`, or `admin`. `delay_history` reads `delay_history_hourly`. `hours` of 0 means all retained buckets. Otherwise `hours` must be 1 to 8784. `bucket` must be `hour`, `day`, or `week`.

`dashboard/nginx.conf` proxies `/graphql`, `/auth/`, `/billing/`, and `/api/chat` to `http://api:8000`. `/api/chat` is rewritten to `/chat`. Everything else is the single-page app.

Routes in `dashboard/src/App.tsx`:

| Path | Page | Gate |
| --- | --- | --- |
| `/` | `pages/LiveMap.tsx` | none |
| `/stations` | `pages/Stations.tsx` | none |
| `/login`, `/register` | `auth/LoginPage.tsx`, `auth/RegisterPage.tsx` | none |
| `/pricing` | `billing/PricingPage.tsx` | none |
| `/analytics` | `pages/Analytics.tsx` | none in the router |
| `/history` | `pages/History.tsx` | `ProtectedRoute` |
| `/chat` | `pages/ChatAssistant.tsx` | `ProtectedRoute` |
| `/account` | `billing/AccountPage.tsx` | `ProtectedRoute` |

The GraphQL client posts to `/graphql` with credentials. See `dashboard/src/graphql/client.ts`. There is no Clerk import under `dashboard/src`.

`docker-compose.yml` publishes the API on `127.0.0.1:8001`. The dashboard container has no host port. `cloudflared` joins the dashboard.

### Running API and UI

`stack.yaml` does not publish the API port. The API and the dashboard share an `edge` network. The dashboard address on that network is `10.254.41.6`. `API_RATE_LIMIT_TRUSTED_PROXIES` is that address, so the API treats the dashboard nginx as its proxy.

The running binary `/usr/local/bin/irish-rail-api` contains the strings `Clerk` and `Polar`. It does not contain `Stripe` or `/auth/login`. The running dashboard bundle contains `Clerk`. It also still has `LoginPage` and `RegisterPage` chunks. Inference. The published site is the Clerk and Polar build, not this branch's Stripe and local-login build.

`stack.yaml` sets `POLAR_CHECKOUT_ENABLED` from the environment, defaulting the compose substitution to `false`. Whether checkout is on depends on `stack.env`, which is not quoted here.

The public name in both compose files is `https://traein.semyon.ie`.

## Deploy

Production is not `docker compose up` from this repository.

`/home/semyon/server-stacks/irish-rail/README.md` says to run a one-off daemon container so migrations apply, then start `daemon`, `api`, and `dashboard` with `--no-build`. It says not to recreate `irish_rail_db` until the PostgreSQL 18 volume mount is repaired. The live data directory is the anonymous volume, not the named volume `stack.yaml` declares. Read that README before recreating anything.

`stack.yaml` also defines `migrate`, `bus-daemon`, and a fixed `edge` subnet. `docker-compose.yml` in this repository has none of those. Its daemon does not set `SKIP_DB_MIGRATIONS`. The production daemon does, so schema changes are applied by the one-off migrate container instead of by every daemon start.

`Jenkinsfile` checks out `*/main` and runs `docker compose up -d --no-build` with this repository's compose file. Inference. That job does not deploy the stack that is running, because the running stack is `stack.yaml` and includes services this compose file does not define.

GitHub Actions, `.github/workflows/ci.yml`, runs on pull requests and on pushes to `main`. It checks and tests the Rust API, type-checks and builds the dashboard, and compiles the Python sources. It does not deploy.

## Where to add a feature

On this branch, for rail data the running site does not already have:

1. Poll it from `daemon.py`. Add the task in `run` next to the existing `schedule_task` calls. Keep dedup beside the other hashes, and strip volatile timestamps before hashing.
2. Store it in a new file under `migrations/`. `docker-entrypoint.sh` applies `schema.sql` and then every file in that directory, in name order. Prefer a new migration over editing `schema.sql` once a database already exists. The production entry path is the one-off migrate container, and this branch's daemon image still migrates on startup.
3. Read it from a resolver in `api/src/schema/`. Add the type to the merged query in `api/src/schema/mod.rs` only if it is a new query object. Clamp numeric arguments the way `api/src/schema/bounds.rs` does.
4. Show it from `dashboard/src/pages` and add a route in `dashboard/src/App.tsx`. If the browser calls a new API prefix, add a `location` in `dashboard/nginx.conf`. The current proxy only forwards GraphQL, auth, billing, and chat.

Do not add bus, Clerk, Polar, weather, traffic, or archive compaction on this branch and expect production to pick it up. That code is on `origin/main` at `8048ab3`, which is the tag on the running images. It is not on `origin/dev`. Land it on `dev` first, then change it here. A migration numbered `009` or higher in this branch will collide with the files already applied on the live database.

Do not point a new backup, restore, or compose change at `ireland_public` from a laptop script. The live writers are the cron script and the B2 timer above.
