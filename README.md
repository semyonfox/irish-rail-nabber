# Irish Public Data API

Real-time Irish Rail collector with TimescaleDB. Phase 1 MVP complete.

## Quick Start

```bash
docker-compose up -d
sleep 30
docker-compose logs daemon
```

That's it. Database runs forever, daemon collects 24/7.

## What It Does

Collects Irish Rail data every 3 seconds into TimescaleDB:
- Train positions (latitude/longitude, updated in real-time)
- Station arrivals/departures (39+ events per station per poll)
- Full journey tracking (8+ stops per train per hour)
- Forever archive with compression (saves 90% space after 7 days)

All data is deduplicated (only stores when values change).

## Database Schema

- `stations` - 171 static reference records
- `train_snapshots` - Train positions (3s polling, ~28k/day per train)
- `station_events` - Board updates (3s polling, ~1.7M/day)
- `train_movements` - Journey logs (60s polling, ~1M/day)
- `fetch_history` - API call metadata (success/skip/error)

Indexes on: train_code, station_code, fetched_at

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for:
- Polling strategy (why 3s)
- Deduplication logic
- TimescaleDB configuration
- Docker setup

## Data Analysis

Extract deep insights from your Irish Rail dataset with the consolidated docs in `docs/analysis/`.

Local-only exploratory scripts live in `private/analysis/` and are intentionally ignored by git.

### Analysis documents

- `docs/analysis/README.md` - index for the reduced analysis doc set
- `docs/analysis/overview.md` - main summary and recommendations
- `docs/analysis/bottleneck.md` - Galway-Athenry bottleneck deep dive
- `docs/analysis/operations.md` - action plan, alerting, and predictive follow-up
- `DATA_SOURCES.md` - API caveats and weaker-coverage areas

## Testing

See [TESTING.md](TESTING.md) for:
- Verification checklist
- 24-hour stability test
- Troubleshooting guide

## Roadmap

See [ROADMAP.md](ROADMAP.md) for 5-phase development plan (€5k/mo revenue target).

Phase 2: GraphQL API (Week 2)
Phase 3-5: Dublin Bikes, NTA GTFS-RT, planning apps, weather, power prices, etc.

## Tech Stack

- **Database**: TimescaleDB 16 (PostgreSQL, time-series optimized)
- **Daemon**: Python 3.11 + asyncio (356 LOC)
- **Container**: Docker + Docker Compose (single service)
- **API**: Strawberry GraphQL (Phase 2, Week 2)

## License

MIT
