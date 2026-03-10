# Irish Public Data API

Ireland's only live public data API. Real-time train positions, bus routes, planning applications, weather, air quality, and more in one GraphQL service.

**Status**: Phase 1 MVP (Irish Rail collector) — Phase 2 GraphQL API shipping Week 2

---

## Quick Start

```bash
# Clone and run (requires Docker + Docker Compose)
git clone https://github.com/semyonfox/irish-public-data.git
cd irish-public-data

# Start collector + database
docker-compose up -d

# Verify in 30 seconds
docker-compose logs daemon

# Query database (live data)
psql -h localhost -U irish_data -d ireland_public \
  -c "SELECT COUNT(*) FROM train_snapshots;"
```

**No setup needed. 30 seconds to live Irish Rail data.**

---

## What This Does

Collects **real-time Irish Rail data every 3 seconds** into TimescaleDB:
- Train positions (latitude/longitude)
- Station arrivals/departures  
- Delays and status updates
- Forever archive with compression after 7 days

**Upcoming** (Phase 2-3):
- Dublin Bikes, NTA GTFS-RT (buses/Luas)
- Planning applications, weather, air quality
- Traffic, CSO stats, power prices, floods

**100% public Irish data. €25/mo subscription model.**

---

## Architecture

```
Irish Rail API (30s polls)
         ↓
    daemon.py (async/await)
         ↓
    TimescaleDB (hypertables)
         ↓
    GraphQL API (Week 2)
         ↓
     Clients
```

Single container. Homelab-friendly. Scales to €5k/mo.

---

## Data Sources (11 Total)

| Source | Frequency | Status | Phase |
|--------|-----------|--------|-------|
| Irish Rail | 3s | ✅ Collecting | 1 |
| Dublin Bikes | 1min | 📋 Phase 2 | 2 |
| NTA GTFS-RT | 30s | 📋 Phase 2 | 2 |
| Planning Apps | Daily | 📋 Phase 3 | 3 |
| CSO Stats | Hourly | 📋 Phase 3 | 3 |
| Met Éireann | 15min | 📋 Phase 3 | 3 |
| EPA Air | 5min | 📋 Phase 3 | 3 |
| OPW Floods | 15min | 📋 Phase 3 | 3 |
| TII Traffic | 5min | 📋 Phase 3 | 3 |
| Oireachtas | Hourly | 📋 Phase 4 | 4 |
| SEM-O Power | Daily | 📋 Phase 4 | 4 |

---

## Next Steps

- **Week 2**: GraphQL API (Strawberry, ~200 LOC)
  - Query: `recentTrains(hours: 24)`
  - Deploy to localhost:8000
  - Test latency (<200ms)

See **[ROADMAP.md](ROADMAP.md)** for full development plan.

---

## Development

### Local Testing
See [LOCAL_TESTING.md](LOCAL_TESTING.md) for:
- Docker setup verification
- Database healthchecks
- Data collection validation
- 24-hour uptime testing

### Setup & Usage
- [SETUP.md](SETUP.md) - Installation instructions
- [USAGE.md](USAGE.md) - Running the daemon
- [ROADMAP.md](ROADMAP.md) - Development phases and timeline

### Database Schema
TimescaleDB hypertables with automatic compression (7 days) and forever retention:
- `stations` - Static reference data (171 stations)
- `train_snapshots` - Train positions (3s interval)
- `station_events` - Arrivals/departures (3s interval)
- `train_movements` - Full journey tracking (60s interval)
- `fetch_history` - API call metadata

---

## Tech Stack

| Layer | Tech |
|-------|------|
| Database | TimescaleDB 16 (PostgreSQL) |
| Daemon | Python 3.11 + asyncio |
| API | Strawberry GraphQL (Week 2) |
| Container | Docker + Docker Compose |
| Hosting | Homelab NAS → Timescale Cloud (optional) |
| Payments | Stripe (Phase 2) |

---

## License

MIT - Free to use and modify.

---

## Contributing

This is a solo project launching a business. Public contributions welcome after Phase 2 (June 2026).

---

## Questions?

Irish Rail data questions → See comments in daemon.py
API/database questions → Open an issue on GitHub
