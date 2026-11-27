# Roadmap

Goal: €5k/month by Q4 2026.

Phase status reflects the current state of the codebase, not the original plan.

## Phase 1 — MVP (complete)

- Irish Rail polling daemon, TimescaleDB hypertables ([docs/scraper.md](docs/scraper.md))
- Dedup at four granularities, content-hash based ([docs/scraper.md#deduplication](docs/scraper.md#deduplication))
- 90-day rolling window with 7-day compression
- Ordered Docker Compose deployment with schema-first migrations ([docs/deployment.md](docs/deployment.md))

## Phase 2 — API, auth, billing (in progress)

**Done:**

- Rust Axum service with async-graphql ([docs/api.md](docs/api.md))
- Clerk production authentication with local plan roles ([docs/auth-billing.md](docs/auth-billing.md))
- Polar checkout, customer portal and replay-safe entitlement webhooks
- React 19 dashboard with live map, pricing page, account page ([docs/dashboard.md](docs/dashboard.md))
- Cloudflare Tunnel deployment at [traein.semyon.ie](https://traein.semyon.ie)
- Tiered API rate limits and paid rail assistant

**Remaining:**

- Activate and verify Polar sandbox, then production products and webhooks ([docs/auth-billing.md#polarsh-flow](docs/auth-billing.md#polarsh-flow))
- Public launch on r/ireland

Target MRR after Phase 2 launch: **€100–250** (5–10 paying users).

## Phase 3 — AI chatbot and analytics

- Add persistent multi-turn chat sessions and streaming responses ([docs/chatbot.md](docs/chatbot.md))
- Extend the assistant with network-path and service-summary tools
- Continuous aggregates for delay/punctuality (Timescale materialised views)
- Predictive delay model fed by `train_movements` history

Target MRR: **€750**.

## Phase 4 — Specialisation

Add datasets that justify the Pro tier on their own:

- Bus static GTFS, minute-level TripUpdates, stop boards, and route delay history (implemented locally; NTA key and production rollout pending)
- Dublin Bikes (7-year CSV import + 1-minute polling)
- NTA GTFS-RT for Luas
- Met Éireann weather (15min)
- EPA Air Quality (5min)
- OPW Floods (15min)

Industry-specific GraphQL extensions (proptech, newsroom, researcher).

Target MRR: **€1 500**.

## Phase 5 — Scale

- Read replicas (split analytics from collector)
- Optional Timescale Cloud migration
- WebSocket subscriptions for real-time feeds
- Custom data exports (Parquet / CSV)
- SLA (99.9%) with Railway + Fly failover ([docs/deployment.md#cloud-options](docs/deployment.md#cloud-options))

Target MRR: **€5 000**.

## Positioning

> "Ireland's live public data API. data.gov.ie is dead CSVs. We are realtime."

Target users: indie devs, proptech, researchers, newsrooms.

## Success metrics

| Milestone | When | What |
|-----------|------|------|
| Day 7 | post-MVP | 3 k+ train snapshots, 171 stations, docker compose works first-try |
| Day 30 | public beta | GraphQL live, 50 k+ snapshots, 4 free-trial signups |
| Day 90 | Phase 2 launch | €100–250 MRR, 500 k+ snapshots, <1% API failure rate |
| Month 6 | Phase 5 | €5 k MRR |

## Tech stack

```
docker compose
├── db          timescaledb 2.25 / pg 18
├── daemon      python 3.14 + asyncio
├── bus-daemon  python 3.14 + NTA GTFS
├── api         rust + axum + async-graphql
├── dashboard   react 19 + vite+ + tailwind
└── cloudflared edge tunnel
```

Lines of code today: ~3 000. Target by Phase 5: ~6 000.

## Related docs

- [docs/architecture.md](docs/architecture.md) — what the system looks like today
- [docs/auth-billing.md](docs/auth-billing.md) — Polar migration plan
- [docs/chatbot.md](docs/chatbot.md) — the Phase 3 product
- [docs/deployment.md](docs/deployment.md) — when to leave the home server
