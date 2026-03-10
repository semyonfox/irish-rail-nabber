# Development Roadmap

Goal: €5k/mo by Q4 2026

## Phase 1: MVP (Week 1-2) - Irish Rail Only

**Status**: Complete

- Irish Rail 3s polling daemon (356 LOC)
- TimescaleDB schema with hypertables, compression, forever retention
- Docker Compose setup (single container, 30s startup)
- Data collection verified (all 4 endpoints working, deduplication tested)

**Launch**: Day 30 (r/ireland announcement)  
**Revenue**: Free trial → €25/mo flip at Day 90

## Phase 2: Growth (Week 3-4) - €300/mo

### Data Sources
- Dublin Bikes: 7yr CSV import + 1min polling
- NTA GTFS-RT: Buses + Luas 30s polling

### Monetization
- Stripe integration (€25 Coffee Club, €75 Pro)
- JWT auth (Stripe customer_id)
- Rate limiting (1000 req/day free → unlimited paid)

### GraphQL API
- Strawberry GraphQL service (~200 LOC)
- Query: `recentTrains(hours: 24)`
- Multi-source joins

## Phase 3: Analytics (Month 2) - €750/mo

- Planning Applications: Daily scrape
- CSO Stats: Hourly snapshots (CPI, employment)
- Met Éireann: 15min weather polling
- EPA Air Quality: 5min polling
- OPW Floods: 15min polling
- Continuous aggregates (train delay stats, hourly summaries)
- `insights()` query (combined data)

## Phase 4: Specialization (Month 3) - €1.5k/mo

- Oireachtas: Debates + votes daily
- TII Traffic: 5min counter polling
- SEM-O Power Prices: Daily import
- Industry-specific schemas (proptech, newsroom, researcher)

## Phase 5: Scale (Month 4-6) - €5k/mo

- Read replicas (analytics separation)
- Timescale Cloud migration (optional)
- Custom data exports (Parquet, CSV)
- WebSocket subscriptions (real-time feeds)
- SLA guarantees (99.9% uptime)

## Tech Stack (Final)

```
docker-compose.yml:
├── timescaledb:16-alpine
└── daemon (Python 3.11 + asyncio)

api (Phase 2):
├── Strawberry GraphQL
└── FastAPI (REST fallback)

payments (Phase 2):
└── Stripe webhooks + JWT

monitoring (Phase 3):
├── Prometheus exporter
└── Grafana dashboards
```

Codebase: ~500 LOC now → ~2,500 LOC at Phase 2 → ~5,000 LOC full

## Timeline

```
Week 1:   Collector done + verify + cleanup
Week 2:   GraphQL API
Week 3:   Stripe + Dublin Bikes
Month 2:  Phase 2 launch (r/ireland)
Month 3:  5 more data sources
Month 6:  €5k/mo revenue
```

## Success Metrics

**Day 7**:
- TimescaleDB has 3000+ train snapshots
- 171 stations cached
- Docker compose up works first try
- Repo public on GitHub

**Day 30**:
- GraphQL API live (public beta)
- 50k+ snapshots collected
- 4 free trial signups

**Day 90**:
- €100-250/mo MRR (5-10 paying)
- 500k+ snapshots
- <1% API failure rate

## Positioning

"Ireland's LIVE public data API. data.gov.ie is dead CSVs. We are realtime."

Target: Indie devs, proptech, researchers, news
