# Architecture

## Data Flow

```
Irish Rail API
    ↓ (3s polling)
daemon.py (async/await)
    ↓ (hash-based dedup)
TimescaleDB (hypertables)
    ↓ (auto-compress after 7d)
Forever archive
```

## Polling Strategy

Irish Rail API updates every ~3.5 seconds, so:

| Resource | Interval | Why |
|----------|----------|-----|
| Train positions | 3s | Capture movement data |
| Station boards | 3s | Capture schedule/status changes |
| Stations | 24h | Static reference data |

Intervals hardcoded in daemon.py based on API testing.

## Deduplication

Hash-based to avoid duplicates when nothing changes:

1. Calculate hash of API response
2. Compare with previous hash
3. If match: skip INSERT, record as "skipped" in fetch_history
4. If new: INSERT with current timestamp

Benefit: Cleaner archive (only real changes), faster queries, better analytics.

Example:
```
Poll 1: Trains moved → 40 records inserted
Poll 2: Same positions → 0 records (skipped, 2x faster)
Poll 3: Trains moved → 35 records inserted
```

## TimescaleDB Configuration

### Hypertables

**train_snapshots**: Time-series of train positions
- Indexed on: train_code, fetched_at
- Partitioned by: fetched_at (automatic)
- ~28,800 records/day per train (3s polling × 1440 mins)

**station_events**: Time-series of arrivals/departures
- Indexed on: station_code, train_code, fetched_at
- Partitioned by: fetched_at (automatic)
- ~28,800 records/day per station (3s polling)

**train_movements**: Journey logs
- Indexed on: train_code, train_date, location_code
- Partitioned by: fetched_at (automatic)
- ~1M records/day (78 trains × 8 stops × 1440 polls)

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

Assuming 40-50 live trains, 171 stations:

- Per poll cycle (3s): ~1,000-1,500 records (dedup helps)
- Per day: ~28,800 records per train, ~1M+ total
- Per week: ~200M raw records → ~20MB compressed
- Per 90 days: ~2GB raw → ~200MB compressed

**Total database size**: Stays constant at ~5-10GB (compression + retention).

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
