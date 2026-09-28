# API

Rust service built on Axum 0.8. Exposes a public GraphQL query layer and REST endpoints for authentication and billing. Source under `api/`.

## Endpoints at a glance

| Path | Method | Auth | Purpose |
|------|--------|------|---------|
| `/graphql` | GET | none | Playground UI |
| `/graphql` | POST | optional | Query the live data |
| `/auth/config` | GET | none | Public Clerk key and billing availability |
| `/auth/session` | GET | optional Clerk session | Current app account or `null` |
| `/auth/me` | GET | Clerk session | Current app account |
| `/billing/checkout` | POST | Clerk session | Polar checkout session |
| `/billing/portal` | POST | Clerk session | Polar customer portal |
| `/billing/webhook` | POST | provider signature | Subscription state sync |
| `/health` | GET | none | Liveness probe |

Auth + billing details live in [auth-billing.md](auth-billing.md).

## Module layout

```
api/src/
├── main.rs          Router wiring, CORS, middleware chain
├── state.rs         AppState (pool + GraphQL schema)
├── models.rs        sqlx rows + AuthUser
├── db/
│   ├── mod.rs       pool factory
│   └── users.rs     user lookup + Polar entitlement updates
├── auth/
│   ├── mod.rs
│   ├── clerk.rs     Clerk JWT verification + account provisioning
│   ├── middleware.rs Clerk session extraction → Option<AuthUser>
│   └── handlers.rs  config / session / me
├── billing/
│   ├── mod.rs
│   └── handlers.rs  checkout / portal / webhook
└── schema/
    ├── mod.rs       MergedObject root query + build_schema
    ├── types.rs     scalar mappings
    ├── station.rs   station resolvers
    ├── train.rs     train + movement resolvers
    ├── bus.rs       bus stop boards + route delay resolvers
    └── analytics.rs gated analytics resolvers
```

## GraphQL schema

The root `Query` is a `MergedObject` over four concerns:

```rust
#[derive(MergedObject, Default)]
pub struct Query(StationQuery, TrainQuery, AnalyticsQuery, BusQuery);
```

Examples:

```graphql
query LiveTrains {
  liveTrains {
    trainCode
    latitude
    longitude
    direction
    trainStatus
  }
}

query StationBoard {
  stationBoard(stationCode: "CNLLY") {
    trainCode
    scheduledArrival
    expectedArrival
    lateMinutes
    status
  }
}

query BusStopBoard {
  busStops(search: "Eyre Square", limit: 10) {
    stopId
    stopCode
    stopName
  }

  busStopBoard(stopId: "8460B5220401", limit: 20) {
    routeShortName
    headsign
    scheduledTime
    expectedTime
    delaySeconds
  }
}

query BusRoutePressure {
  busRouteDelays(hours: 24, limit: 20) {
    routeId
    routeShortName
    avgDelaySeconds
    onTimePct
    sampleCount
  }
}

query BusVehicles {
  busVehicles(limit: 2000) {
    vehicleId
    routeShortName
    headsign
    latitude
    longitude
    bearing
    speedMetersPerSecond
    currentStatus
    fetchedAt
  }
}

# gated to coffee/pro/admin roles
query DelayHistory {
  delayHistory(stationCode: "GLWY", hours: 168, bucket: "hour") {
    bucket
    avgLateMinutes
    p95LateMinutes
  }
}
```

### Auth in resolvers

The middleware verifies the Clerk bearer token, falling back to Clerk's `__session` cookie, and inserts `Option<AuthUser>` on every request, including `/graphql`. `main.rs` forwards that into the GraphQL execution context:

```rust
state.schema.execute(req.into_inner().data(auth_user)).await
```

A resolver opts in:

```rust
async fn delay_history(&self, ctx: &Context<'_>, ...) -> Result<Vec<DelayBucket>> {
    let user = ctx.data::<Option<AuthUser>>().ok().and_then(|u| u.as_ref());
    match user {
        Some(u) if u.role != "free" => { /* query */ }
        _ => Err("Paid plan required".into()),
    }
}
```

This keeps anonymous queries working while letting individual fields enforce a paywall.

### Numeric query bounds

GraphQL numeric inputs are clamped before SQL binding so direct callers cannot
bypass the service's query-cost limits:

| Field | Inclusive range |
|---|---|
| `stationBoard.limit` | 1–200 |
| `trainHistory.hours` | 1–168 |
| `hourlyDelays.hours` | 1–168 |
| `stationDelayStats.hours` | 1–168 |
| `stationDelayStats.limit` | 1–100 |
| `routeReliability.hours` | 1–720 |
| `routeReliability.minTrains` | 1–20 |
| `busStops.limit` | 1–200 |
| `busStopBoard.limit` | 1–200 |
| `busRouteDelays.hours` | 1–72 public; 1–168 Coffee/Pro/admin |
| `busRouteDelays.limit` | 1–100 |
| `busVehicles.limit` | 1–3000 |

## Auth middleware

`auth::middleware::auth_middleware` runs once per request:

1. Read the Clerk bearer token, falling back to Clerk's `__session` cookie.
2. Verify its RS256 signature, issuer, lifetime and authorized party against Clerk's JWKS.
3. Insert `Some(AuthUser { id, email, role })` into request extensions on success, `None` otherwise.

It never rejects. Handlers and resolvers decide whether auth is required.

See [auth-billing.md](auth-billing.md) for Clerk provisioning and Polar role sync.

## Environment

The API reads `.env.local` first, then `.env`. Required:

```
DATABASE_URL=<private connection string>
CLERK_PUBLISHABLE_KEY=pk_live_...
CLERK_SECRET_KEY=sk_live_...
CORS_ORIGINS=https://traein.semyon.ie
APP_URL=https://traein.semyon.ie
API_RATE_LIMIT_FREE_TIER_LIMIT=25000
API_RATE_LIMIT_COFFEE_TIER_LIMIT=100000
API_RATE_LIMIT_UNLIMITED_ROLES=pro,admin
API_RATE_LIMIT_IP_SALT=<strong-random-value>
```

Polar keys and the checkout kill switch are in [auth-billing.md](auth-billing.md).

## Building and running

```bash
cd api
cargo build --release
DATABASE_URL='<private connection string>' cargo run --release
```

Inside the compose stack the service is named `api`, exposes `8000` on the docker network, and is reached by the dashboard via the nginx proxy.

## Related docs

- [auth-billing.md](auth-billing.md) — Clerk login, Polar checkout and role gating
- [dashboard.md](dashboard.md) — how the frontend consumes the API
- [chatbot.md](chatbot.md) — how the chatbot wraps GraphQL as MCP tools
- [scraper.md](scraper.md#schema) — the underlying schema being queried
- [data-sources.md](data-sources.md) — upstream field semantics
- [buses.md](buses.md) — NTA feed ingestion, schema, and bus query semantics
