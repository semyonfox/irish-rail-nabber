# Irish Public Data Empire - Development Roadmap

**Goal**: Build Ireland's only live public data API. €5k/mo by Q4 2026.

---

## Phase 1: MVP (Week 1-2) - Irish Rail Only - €100/mo

### ✅ Week 1 - Foundation (DONE)
- [x] Irish Rail 3s polling daemon
- [x] TimescaleDB schema (hypertables, compression, forever retention)
- [x] Docker Compose setup
- [x] Verify data collection → TimescaleDB working
- [x] Push to GitHub public (with documented roadmap)

### Week 2 - GraphQL API
- [ ] Strawberry GraphQL service (100 LOC)
- [ ] Query: `recentTrains(hours: 24)` 
- [ ] Deployment to homelab NAS via Docker
- [ ] Latency target: <200ms p99

**Launch**: Day 30 (r/ireland announcement)
**Revenue**: Free trial → €25/mo flip at Day 90

---

## Phase 2: Growth (Week 3-4) - €300/mo

### Data Sources (2 more)
- [ ] **Dublin Bikes**: 7yr CSV import + 1min polling (~200 LOC)
- [ ] **NTA GTFS-RT**: Buses + Luas 30s polling (~250 LOC)

### GraphQL Expansions
- [ ] `liveBikes(stationId)` query
- [ ] `transitPositions(type: "bus" | "luas")` 
- [ ] Multi-source joins

### Monetization
- [ ] Stripe integration (€25 Coffee Club, €75 Pro) (~300 LOC)
- [ ] JWT auth (Stripe customer_id)
- [ ] Rate limiting (1000 req/day free → unlimited paid)
- [ ] Users table + subscription state

**Revenue Trigger**: r/ireland Day 30 post → 4-5 signups

---

## Phase 3: Analytics (Month 2) - €750/mo

### Data Sources (5 more)
- [ ] **Planning Applications**: Daily scrape (~200 LOC)
- [ ] **CSO Stats**: Hourly snapshots (CPI, employment) (~200 LOC)
- [ ] **Met Éireann Weather**: 15min polling (~150 LOC)
- [ ] **EPA Air Quality**: 5min polling (~150 LOC)
- [ ] **OPW Floods**: 15min polling (~150 LOC)

### Features
- [ ] Continuous aggregates (train delay stats, hourly summaries) (~100 LOC)
- [ ] `insights()` query (combined weather + air + transit)
- [ ] Historical analysis queries
- [ ] Prometheus metrics + Grafana dashboards (~150 LOC)

**Revenue**: 12-15 customers × €25-75

---

## Phase 4: Specialization (Month 3) - €1.5k/mo

- [ ] **Oireachtas**: Debates + votes daily (~200 LOC)
- [ ] **TII Traffic**: 5min counter polling (~150 LOC)
- [ ] **SEM-O Power Prices**: Daily import (~100 LOC)
- [ ] Industry-specific schemas (proptech, newsroom, researcher)

**Revenue**: First enterprise customers

---

## Phase 5: Scale (Month 4-6) - €5k/mo

- [ ] Read replicas (analytics separation)
- [ ] Timescale Cloud migration (optional)
- [ ] Custom data exports (Parquet, CSV)
- [ ] WebSocket subscriptions (real-time feeds)
- [ ] SLA guarantees (99.9% uptime)

---

## Current Status

| Component | Status | Impact |
|-----------|--------|--------|
| **Irish Rail collector** | ✅ 356 LOC | Foundation done |
| **TimescaleDB schema** | ✅ Created | Ready |
| **Docker Compose** | ✅ Setup | Works locally |
| **Data → TimescaleDB** | ⚠️ **UNTESTED** | **Must verify** |
| **SQLite db** | ❌ Still exists | **Must remove** |
| **GraphQL API** | ❌ 0 lines | **Blocks Week 2** |
| **Stripe billing** | ❌ 0 lines | **Blocks revenue** |
| **Docs cleanup** | ⚠️ AI slop | **Must remove** |

---

## This Week's Priorities

### MUST DO (Before committing to GitHub)

1. **Verify daemon → TimescaleDB working** ✅ DONE
    - Tested 30 seconds with live API data
    - All 4 endpoints operational
    - Data parsing verified
    - Deduplication working

2. **Remove old code** ✅ DONE
    - Deleted `archive.py` (obsolete SQLite approach)
    - No dual-system artifacts

3. **Delete AI slop docs** ✅ DONE
    - ✅ SETUP.md (obsolete)
    - ✅ USAGE.md (sqlite references)
    - ✅ LOCAL_TESTING.md (verbose, outdated)

4. **Update README.md** ✅ DONE
    - Updated polling frequency (3s not 30s)
    - All references current

5. **Commit to GitHub** 
   - Public repo: `irish-rail-nabber`
   - Clean git history (no experimental branches)
   - MIT license

---

## Success Metrics (Baselines)

```
Day 7:
  ✅ TimescaleDB has 3000+ train snapshots
  ✅ 171 stations cached
  ✅ Docker compose up works first try
  ✅ Repo public on GitHub

Day 30:
  ✅ GraphQL API live (public beta)
  ✅ 50k+ snapshots collected
  ✅ 4 free trial signups

Day 90:
  ✅ €100-250/mo MRR (5-10 paying)
  ✅ 500k+ snapshots
  ✅ <1% API failure rate
```

---

## Tech Stack (Final)

```
docker-compose.yml:
├── timescaledb:16-alpine (1 service)
└── daemon (Python 3.11 + asyncio)

api (Week 2):
├── Strawberry GraphQL
└── FastAPI (REST fallback)

payments (Week 3):
└── Stripe webhooks + JWT

monitoring (Phase 3):
├── Prometheus exporter
└── Grafana dashboards
```

**Codebase**: ~500 LOC now → ~2,500 LOC at Phase 2 → ~5,000 LOC full

---

## Architecture (MVP)

```
Irish Rail API (3s polling)
    ↓
Daemon (daemon.py)
    ↓ (async/await)
TimescaleDB
    ↓
GraphQL API (Week 2)
    ↓
Client (curl/web)
```

**No Kubernetes, no zero-downtime deployment, no replication.**
**Single homelab NAS with CloudFlare Tunnel for external access.**

---

## Timeline

```
Week 1:   ✅ Collector done + verify + cleanup
Week 2:   GraphQL API
Week 3:   Stripe + Dublin Bikes
Month 2:  Phase 2 launch (r/ireland)
Month 3:  5 more data sources
Month 6:  €5k/mo revenue
```

---

## Positioning

**"Ireland's LIVE public data API. data.gov.ie is dead CSVs. We are realtime."**

- Indie devs: Easy Irish data access
- Proptech: Planning + transport layer
- Researchers: Historical + real-time combined
- News: Live traffic, delays, weather in one place

No competition. Move fast.
