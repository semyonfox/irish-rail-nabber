# API

Rust service built on Axum 0.8. Exposes a public GraphQL query layer and REST endpoints for authentication and billing. Source under `api/`.

## Endpoints at a glance

| Path | Method | Auth | Purpose |
|------|--------|------|---------|
| `/graphql` | GET | none | Playground UI |
| `/graphql` | POST | optional cookie | Query the live data |
| `/chat` | POST | paid role | 401 with no user, 403 for `free`. Handler in `api/src/chat.rs` |
| `/auth/register` | POST | none | Create account |
| `/auth/login` | POST | none | Issue tokens |
| `/auth/refresh` | POST | refresh cookie | Rotate tokens |
| `/auth/logout` | POST | access cookie | Revoke session |
| `/auth/session` | GET | optional cookie | Session probe |
| `/auth/me` | GET | access cookie | Current user |
| `/billing/checkout` | POST | access cookie | Stripe checkout session |
| `/billing/portal` | POST | access cookie | Stripe customer portal |
| `/billing/limits` | GET | none | Tier limits from environment |
| `/billing/usage` | GET | access cookie | Usage |
| `/billing/webhook` | POST | `stripe-signature` | Subscription state sync |
| `/health` | GET | none | Liveness probe |

Routes are wired in `api/src/main.rs`. Checkout, portal, and the webhook call Stripe from `api/src/billing/handlers.rs`. `limits` does not read the cookie. The running API binary is a Clerk and Polar build. See [ARCHITECTURE.md](ARCHITECTURE.md). [auth-billing.md](auth-billing.md) describes Polar as the intended billing path. The handlers in this branch still call Stripe.

## Module layout

```
api/src/
├── main.rs          Router wiring, CORS, middleware chain
├── state.rs         AppState (pool + GraphQL schema)
├── models.rs        sqlx rows + AuthUser
├── db/
│   ├── mod.rs       pool factory
│   └── users.rs     user + refresh_token CRUD
├── auth/
│   ├── mod.rs
│   ├── password.rs  argon2 hash + verify
│   ├── tokens.rs    JWT + opaque refresh tokens
│   ├── middleware.rs JWT extraction → Option<AuthUser>
│   └── handlers.rs  register / login / logout / refresh / me
├── billing/
│   ├── mod.rs
│   └── handlers.rs  checkout / portal / webhook
└── schema/
    ├── mod.rs       MergedObject root query + build_schema
    ├── types.rs     GraphQL object types such as Station and TrainPosition
    ├── station.rs   station resolvers
    ├── train.rs     train + movement resolvers
    └── analytics.rs gated analytics resolvers
```

## GraphQL schema

The root `Query` is a `MergedObject` over three concerns:

```rust
#[derive(MergedObject, Default)]
pub struct Query(StationQuery, TrainQuery, AnalyticsQuery);
```

Examples:

```graphql
query LiveTrains {
  liveTrains {
    trainCode
    latitude
    longitude
    direction
  }
}

query StationBoard {
  stationBoard(stationCode: "CNLLY", limit: 20) {
    trainCode
    scheduledArrival
    expectedArrival
    lateMinutes
    status
  }
}

query DelayHistory {
  delayHistory(stationCode: "GLWY", hours: 168, bucket: "hour") {
    bucket
    avgLateMinutes
    p95LateMinutes
  }
}
```

`delayHistory` is rejected unless the caller has role `coffee`, `pro`, or `admin`. The check is `ensure_premium` in `api/src/schema/analytics.rs`.

### Auth in resolvers

The middleware extracts the access-token cookie into `Option<AuthUser>` on every request, including `/graphql`. `main.rs` forwards that into the GraphQL execution context:

```rust
state.schema.execute(req.into_inner().data(auth_user)).await
```

`ensure_premium` in `api/src/schema/analytics.rs` allows `coffee`, `pro`, and `admin`. A signed-in `free` user gets `coffee or pro subscription required`. A missing user gets `authentication required`. Anonymous queries still work for fields that do not call it.

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

## Auth middleware

`auth::middleware::auth_middleware` runs once per request:

1. Read the `access_token` cookie.
2. Verify the JWT against `JWT_SECRET`.
3. Insert `Some(AuthUser { id, email, role })` into request extensions on success, `None` otherwise.

It never rejects. Handlers and resolvers decide whether auth is required.

See [auth-billing.md](auth-billing.md) for token lifetimes, rotation, and cookie flags.

## Environment

The API reads `.env.local` first, then `.env`. Only `DATABASE_URL` is required. `api/src/db/mod.rs` stops if it is missing. The other names below have defaults. Free and coffee rate limits default to 25000 and 100000 in `api/src/rate_limit.rs`. `docker-compose.yml` sets those same defaults.

```
DATABASE_URL=postgres://irish_data:secure_password@db:5432/ireland_public
JWT_SECRET=<64 hex chars>
JWT_ACCESS_EXPIRY=900
JWT_REFRESH_EXPIRY=604800
COOKIE_SECURE=true
CORS_ORIGINS=https://traein.semyon.ie
APP_URL=https://traein.semyon.ie
API_RATE_LIMIT_FREE_TIER_LIMIT=25000
API_RATE_LIMIT_COFFEE_TIER_LIMIT=100000
API_RATE_LIMIT_UNLIMITED_ROLES=pro,admin
API_RATE_LIMIT_IP_SALT=rail-salt
```

This branch's billing handlers read `STRIPE_*`. See [auth-billing.md](auth-billing.md).

## Building and running

```bash
cd api
cargo build --release
DATABASE_URL=... cargo run --release
```

Inside the compose stack the service is named `api`, exposes `8000` on the docker network, and is reached by the dashboard via the nginx proxy.

## Related docs

- [auth-billing.md](auth-billing.md) — register/login flow, Polar checkout, role gating
- [dashboard.md](dashboard.md) — how the frontend consumes the API
- [chatbot.md](chatbot.md). That page describes an MCP wrapper. `api/src/chat.rs` sends OpenAI-style tool definitions and runs GraphQL in process. This branch has no MCP server.
- [scraper.md](scraper.md#schema) — the underlying schema being queried
- [data-sources.md](data-sources.md) — upstream field semantics
