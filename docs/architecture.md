# Architecture

Five application and edge services, plus one database.

```
Irish Rail Realtime API ──► rail daemon ──┐
                                          │
NTA GTFS + GTFS-Realtime ─► bus daemon ───┤
                                          ▼
TimescaleDB ◄──sqlx──► API (Rust: GraphQL, auth, billing, chat) ◄──► Polar.sh
                            ▲
                            │ Clerk bearer token
                            ▼
                      dashboard (React 19)
                            ▲
                            │
                    Cloudflare Tunnel
                            ▲
                            │
                    traein.semyon.ie
```

## Service responsibilities

| Service | Language | Job | Doc |
|---------|----------|-----|-----|
| `daemon` | Python | polls Irish Rail, dedups, writes time-series | [scraper.md](scraper.md) |
| `bus-daemon` | Python | imports NTA GTFS and polls bus timings + vehicle positions | [buses.md](buses.md) |
| `api` | Rust (Axum) | GraphQL, auth, billing, and tool-grounded rail chat | [api.md](api.md) |
| `dashboard` | TypeScript (React) | rail map, station and bus UI, account, pricing | [dashboard.md](dashboard.md) |
| `db` | PostgreSQL 18 + TimescaleDB | hypertables and relational tables | [scraper.md](scraper.md#schema), [buses.md](buses.md#tables), [auth-billing.md](auth-billing.md#schema) |
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

transit_feed_versions            ── immutable NTA static-feed identities
bus_agencies/routes/trips/stops  ── versioned GTFS reference data
bus_stop_times                   ── service-day schedule seconds
bus_stop_updates (regular table) ── deduplicated realtime predictions and delays
bus_trip_update_freshness        ── current full-feed trip membership
bus_vehicle_positions            ── current full-feed bus locations

users                            ── account, role, polar_customer_id
billing_webhook_events           ── Polar replay protection
```

Full DDL and rationale in [scraper.md](scraper.md#schema) and [auth-billing.md](auth-billing.md#schema).

## Request shapes

- **Anonymous web visitor**: dashboard → `/graphql` → Postgres. Public resolvers only.
- **Free-tier user**: Clerk session token → `/graphql`. Middleware injects the local `AuthUser`; resolvers gate analytics behind its Polar-managed role.
- **Paid user (assistant)**: dashboard → API `/chat` → bounded internal GraphQL tool calls → Postgres. The Rust chat handler checks the local plan before any model request.
- **Polar webhook**: Polar → `/billing/webhook` → signature check → role update in `users`.

## Local vs prod

The repository `docker-compose.yml` is the development contract. Production uses `/home/semyon/server-stacks/irish-rail/stack.yaml` and a private `stack.env`; Jenkins targets those exact operator files. Production-specific details include:

- Clerk production keys and exact-host DNS
- `CORS_ORIGINS=https://traein.semyon.ie`
- `cloudflared` service active with a real `CLOUDFLARE_TUNNEL_TOKEN`
- Polar live keys instead of sandbox
- schema-first rollout of daemon, API and dashboard without recreating the database

Fresh PG18 stacks mount their named volume at `/var/lib/postgresql`. The current production database still uses a legacy anonymous parent-volume mount and must not be recreated until that data is backed up and migrated.

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
