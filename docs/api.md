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

### Admin insights

These fields require the `admin` role:

| Field | Window and limits |
|---|---|
| `serviceAlerts` | Up to 90 inclusive Irish dates. Optional source and category filters. Pages contain 25 alerts by default, up to 100, with a maximum of 100 pages. |
| `serviceAlert` | Latest revision by source (`RAIL` or `BUS`) and alert key, including rail corridor, impact figures and `impactWindowEnd` when available. `neverRan` flags rail notices marked as withdrawn or last seen before their stated start. |
| `delayStretches` | Up to 7 inclusive service dates for bus and 31 for rail. Ranks directed stretches by net delay. Returns 30 rows by default, up to 100. |
| `railDwellHotspots` | Up to 31 inclusive service dates, ranked by net delay while stopped. Returns 10 rows by default, up to 100. |

Both rankings accept a scheduled departure hour band in Irish time with an exclusive end.
The minimum trip count defaults to 10. `netDelayMinutes` is the sum of signed delay gains
in minutes. Both rankings require a positive net sum. `addedMinutes` counts only positive gains.
Stretch means and population standard deviations use trip-weighted sums. Schedule overrun
is relative to total scheduled time and is null when that total is zero.

For each stretch, `daysWithData` counts distinct service dates with records in the selected
date range and hour band. Today counts as one day when partial data is available.

Bus stretches combine all matching hours by directed stop pair. Stop names, coordinates
and route names come from the newest timetable version in the group. The median bucket
contains the lower middle trip in the merged signed gain histogram. `medianGainLowerS`
is inclusive and `medianGainUpperS` is exclusive. A null bound means the bucket is open
on that side. `gainAtLeastTwoMinutesPct` is the percentage of histogram observations with
a gain of 120 seconds or more. Both median bounds and this percentage are null for rail.
The bus range is capped at seven days because there are about 250,000 hourly records per
day and the query has a five-second time limit.

Rail impact is measured for delay, disruption and works notices. `impactWindowEnd`
is the earliest of the scheduled end, last sighting and 24 hours after the stated start.
`impactEvents` counts station board readings during that window. Averages cover every
train on the boards at the corridor stations, weighted by poll count. The earlier window
covers the two hours before the notice's stated start.
When impact processing marks a notice as never having run, `neverRan` is true and
`impactWindowEnd` and the impact figures are null.

Each Insights query runs with a five-second statement timeout, parallel query workers
disabled and a custom plan for the selected dates.

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

## Anonymous rate limits behind proxies

Anonymous POST requests to `/graphql` and `/chat` use the TCP peer address as
their rate-limit identity. Client-supplied `X-Real-IP` and `CF-Connecting-IP` are
ignored. `X-Forwarded-For` is accepted only when the immediate peer is listed in
`API_RATE_LIMIT_TRUSTED_PROXIES`, a comma-separated list of exact IPv4 or IPv6
addresses. The default is empty, so forwarding headers have no effect.

For a trusted peer, the API walks `X-Forwarded-For` from right to left, stopping
at the first untrusted address. Missing or malformed headers fall back to the
peer. Configure only proxies that overwrite the incoming header or append the
actual peer address. Never trust an entire client network. Missing peer metadata
shares one anonymous bucket rather than trusting a header.

The dashboard nginx proxy currently derives its forwarded identity from
`CF-Connecting-IP`. Trust that nginx peer only when it is reachable exclusively
through the Cloudflare Tunnel boundary that supplies that header. Keep the API
port private. Without trusted proxy configuration, visitors behind a proxy share
its anonymous quota. Set stable proxy addresses before enabling trust.

Set `API_RATE_LIMIT_IP_SALT` to a strong random value in the private operator
environment. Startup warns when it is missing, empty or still `rail-salt`.
Raw IP addresses are hashed before usage storage and are not logged here.

GET `/graphql` serves only the playground HTML, so it remains unmetered.
GraphQL queries execute via POST and count towards the quota. OPTIONS remains
unmetered for CORS preflight.

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
