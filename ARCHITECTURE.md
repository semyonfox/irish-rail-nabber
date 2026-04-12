# Architecture

## Data Flow

```
track circuits / signal blocks
    -> Irish Rail CTC
        -> HACON/Siemens middleware (~60s bulk refresh cycle)
            -> SQL Server database
                -> ASP.NET ASMX API (194.106.151.106, no CDN, no HTTP cache)
                    ↓
                daemon.py (async/await, aiohttp)
                    ↓ (content-hash dedup, strips Servertime/Querytime)
                TimescaleDB (hypertables)
                    ↓ (auto-compress after 7d)
                Forever archive
```

## Polling Strategy

benchmarked April 2026. the upstream data pipeline has a ~60s bulk refresh cycle with event-driven trickles in between. individual train positions update when they cross signal block boundaries (~10-60s depending on line).

| Resource | Interval | Why |
|----------|----------|-----|
| Train positions | 10s | matches ~10s server-side refresh. 3s was 75% wasted |
| Station boards | 15s | bulk flush ~60s, but busy stations trickle every ~15-30s |
| Train movements | 60s | event-driven only, changes on arrival/departure |
| Stations | 24h | static reference data |

previous 3s intervals were based on an incorrect assumption. see `DATA_SOURCES.md` for full benchmarking details.

## Deduplication

hash-based to avoid duplicates when nothing changes:

1. strip `<Servertime>` and `<Querytime>` tags from response (these change every request, not real data)
2. calculate MD5 hash of cleaned content
3. compare with previous hash for that endpoint/entity
4. if match: skip INSERT, record as "skipped" in fetch_history
5. if new: INSERT with current timestamp

three levels of dedup:
- **whole-endpoint**: trains XML hashed as one blob (getCurrentTrainsXML)
- **per-station**: each station board hashed independently (171 hashes maintained)
- **per-train-per-station**: station events fingerprinted by (status, late, location, duein, expected times)
- **per-journey**: train movements hashed per train_code:train_date

**known issue (pre-April 2026)**: station board dedup was hashing raw XML including Servertime/Querytime fields. every poll appeared "changed", defeating dedup entirely and inserting duplicate rows. fix: strip timestamp tags before hashing.

## TimescaleDB Configuration

### Hypertables

**train_snapshots**: Time-series of train positions
- Indexed on: train_code, fetched_at
- Partitioned by: fetched_at (automatic)
- ~8,640 records/day per train (10s polling × 1440 mins, with dedup)

**station_events**: Time-series of arrivals/departures
- Indexed on: station_code, train_code, fetched_at
- Partitioned by: fetched_at (automatic)
- ~5,760 records/day per station (15s polling, with dedup)

**train_movements**: Journey logs
- Indexed on: train_code, train_date, location_code
- Partitioned by: fetched_at (automatic)
- actual insert rate is low due to movement dedup (changes only on arrival/departure)

### Compression & Retention

- After 7 days: Auto-compress (saves 90% space)
- After 90 days: Auto-delete (rolling window)
- Result: Constant database size (~5-10GB for full 90-day window)

## Docker Setup

```
docker-compose.yml:
├── timescaledb:16-alpine
│   ├── 5432:5432 (PostgreSQL)
│   ├── Volume: postgres_data (persists)
│   └── Health check: pg_isready
└── daemon
    ├── Python 3.11
    ├── Depends on: timescaledb (healthy)
    └── Logging: JSON (10MB max, 3 files)
```

## Startup Sequence

1. `docker-compose up -d`
2. TimescaleDB initializes (30s)
3. docker-entrypoint.sh waits for DB health check
4. schema.sql runs (creates tables, hypertables, indexes)
5. daemon.py starts
6. Fetches 171 stations (reference data)
7. Begins 3s polling loop

Total startup: 30-40 seconds

## Tables

### Static Data
- `stations`: 171 records (station_code, name, lat/lon)

### Time-Series (Hypertables)
- `train_snapshots`: Train positions every 3s (when changed)
- `station_events`: Board arrivals/departures every 3s (when changed)
- `train_movements`: Full journey logs every 60s

### Metadata
- `fetch_history`: Record of every API call (success/failed/skipped)
- `fetch_schedules`: Configuration (intervals, enabled status)

## Sample Queries

```sql
-- Find all positions of a train
SELECT * FROM train_snapshots 
  WHERE train_code = 'D123'
  ORDER BY fetched_at DESC;

-- Find all events at a station
SELECT * FROM station_events 
  WHERE station_code = 'CNLLY'
  ORDER BY fetched_at DESC;

-- Get latest positions (using hypertable optimization)
SELECT DISTINCT ON (train_code) * FROM train_snapshots
  ORDER BY train_code, fetched_at DESC;
```

## Storage Estimates

assuming 30-50 live trains, 171 stations, with corrected polling intervals:

- train snapshots: ~8,640 polls/day × ~40 trains = ~345k potential rows, but dedup reduces to ~50k actual inserts (data changes ~15% of polls)
- station events: ~5,760 polls/day × 171 stations, but per-station dedup means only ~10% insert = ~100k rows/day
- train movements: ~1,440 polls/day × ~40 trains, but content-hash dedup means ~5k actual inserts/day

**total database size**: stays constant at ~2-5GB (compression + retention), significantly lower than previous 3s polling estimates.

## Known Issues

### docker bridge network has no outbound internet

the daemon container has **never reliably reached the API**. 2565/2620 train polls failed with timeouts since first deploy (April 1). this is NOT related to Mullvad (only installed April 11).

**root cause**: nftables is active on the host and blocking outbound traffic from docker bridge networks. DNS resolves fine (docker's internal `127.0.0.11` resolver), but TCP connections to any external IP time out — including google, not just Irish Rail.

**confirmed**: `--network host` works perfectly. the `irish-rail-nabber_default` bridge network does not.

the 19 successful polls on April 3 16:00 were likely during a brief window when nftables rules were reloaded or docker was restarted.

**fix options** (pick one):
1. add nftables rules to allow docker bridge outbound traffic
2. switch daemon to `network_mode: host` in docker-compose.yml (quick fix, loses container network isolation)
3. configure docker to use nftables backend (`"iptables": false` in `/etc/docker/daemon.json`)

### station board dedup bug

`Servertime` and `Querytime` XML fields change on every API response (server clock, not real data). the daemon hashes raw XML including these fields, so every poll appears "changed" and inserts duplicate rows. fix: strip these tags before hashing with `re.sub(r"<(?:Servertime|Querytime)>[^<]*</(?:Servertime|Querytime)>", "", xml)`.

## No Configuration

- Hardcoded polling intervals
- Hardcoded database connection
- Hardcoded schema (auto-created)
- No env vars needed (except DATABASE_URL for non-Docker)
- Just run: `docker-compose up -d`

## Next Phase

Add GraphQL API to query this data (Phase 2, Week 2):

```graphql
query {
  recentTrains(hours: 24) {
    trainCode
    latitude
    longitude
    delayMins
  }
}
```

Same docker-compose, add `api` service alongside `daemon`.
