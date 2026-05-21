# Architecture

Four services, one database.

```
                 ┌────────────────────────────────────────────┐
                 │     Irish Rail Realtime API (ASMX/XML)     │
                 │      api.irishrail.ie  (HACON upstream)    │
                 └──────────────────────┬─────────────────────┘
                                        │
                                  HTTP polling
                                        │
            ┌───────────────────────────▼───────────────────────────┐
            │                  daemon (Python 3.11)                  │
            │   async fetch, content-hash dedup, schema writes       │
            └───────────────────────────┬───────────────────────────┘
                                        │
                                  INSERT (sqlx)
                                        │
                ┌───────────────────────▼───────────────────────┐
                │       TimescaleDB (PostgreSQL 18 + ext)        │
                │   hypertables: train_snapshots,                │
                │   station_events, train_movements              │
                │   relational: stations, users, refresh_tokens  │
                └───────┬────────────────────────────┬──────────┘
                        │                            │
                  read (sqlx)                  read (sqlx)
                        │                            │
        ┌───────────────▼───────────┐     ┌──────────▼─────────┐
        │   api (Rust, Axum)         │     │  chatbot service    │
        │   /graphql  /auth/*        │◄────│  (MCP tools over    │
        │   /billing/*  /health      │     │   GraphQL schema)   │
        └───────┬────────────────────┘     └─────────────────────┘
                │ HTTP (cookies)
                ▼
        ┌──────────────────────────┐
        │   dashboard (React 19,    │       ┌──────────────────────┐
        │   Vite+, URQL, Tailwind)  │       │  Polar.sh (or Stripe) │
        │                           │◄──────│  Checkout + webhooks  │
        └──────────────────────────┘       └──────────────────────┘
                │
                ▼
        Cloudflare Tunnel  →  traein.semyon.ie
```

## Service responsibilities

| Service | Language | Job | Doc |
|---------|----------|-----|-----|
| `daemon` | Python | polls Irish Rail, dedups, writes time-series | [scraper.md](scraper.md) |
| `api` | Rust (Axum) | GraphQL query layer, auth, billing webhooks | [api.md](api.md) |
| `dashboard` | TypeScript (React) | live map, station UI, account, pricing | [dashboard.md](dashboard.md) |
| `chatbot` | TypeScript/Python | natural-language queries via tool calls | [chatbot.md](chatbot.md) |
| `db` | PostgreSQL 18 + TimescaleDB | hypertables and relational tables | [scraper.md](scraper.md#schema), [auth-billing.md](auth-billing.md#schema) |
| `cloudflared` | — | edge tunnel to `traein.semyon.ie` | [deployment.md](deployment.md) |

The dashboard never reaches the database directly. Everything goes through the API.

## Data model at a glance

```
stations (171, static)
    └── reference codes used by every time-series table

train_snapshots (hypertable)     ── train positions (lat/lon, status)
station_events  (hypertable)     ── arrival/departure board entries
train_movements (hypertable)     ── per-train per-stop movement log
fetch_history                    ── audit of every upstream call

users                            ── account, role, polar_customer_id
refresh_tokens                   ── opaque, hashed at rest
```

Full DDL and rationale in [scraper.md](scraper.md#schema) and [auth-billing.md](auth-billing.md#schema).

## Request shapes

- **Anonymous web visitor**: dashboard → `/graphql` → Postgres. Public resolvers only.
- **Free-tier user**: cookie `access_token` → `/graphql`. Middleware injects `AuthUser`; resolvers can gate analytics behind role.
- **Paid user (chatbot)**: dashboard → `/chat` → chatbot service → tool calls against the API → Postgres. Tier check at the chatbot entrypoint, not per-tool.
- **Polar webhook**: Polar → `/billing/webhook` → signature check → role update in `users`.

## Local vs prod

The whole stack runs from a single `docker-compose.yml`. Production differences are env-only:

- `COOKIE_SECURE=true`
- `CORS_ORIGINS=https://traein.semyon.ie`
- `cloudflared` service active with a real `CLOUDFLARE_TUNNEL_TOKEN`
- Polar live keys instead of sandbox

See [deployment.md](deployment.md) for the full env matrix.

## Where things live in the repo

```
.
├── api/                  Rust Axum service        (docs/api.md)
├── dashboard/            React + Vite+ UI         (docs/dashboard.md)
├── daemon.py + Dockerfile  Python scraper         (docs/scraper.md)
├── migrations/           SQL migrations
├── data/                 Static GeoJSON inputs    (docs/network-graph.md)
├── network_graphs/       Generated graph outputs  (docs/network-graph.md)
├── docs/                 This folder
├── docker-compose.yml    Single-host orchestration (docs/deployment.md)
└── private/              Gitignored: recovery plan, exploratory analysis
```
