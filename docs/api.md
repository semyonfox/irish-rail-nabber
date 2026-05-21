# API

Rust service built on Axum 0.8. Exposes a public GraphQL query layer and REST endpoints for authentication and billing. Source under `api/`.

## Endpoints at a glance

| Path | Method | Auth | Purpose |
|------|--------|------|---------|
| `/graphql` | GET | none | Playground UI |
| `/graphql` | POST | optional | Query the live data |
| `/auth/register` | POST | none | Create account |
| `/auth/login` | POST | none | Issue tokens |
| `/auth/refresh` | POST | refresh cookie | Rotate tokens |
| `/auth/logout` | POST | access cookie | Revoke session |
| `/auth/me` | GET | access cookie | Current user |
| `/billing/checkout` | POST | access cookie | Polar checkout session |
| `/billing/portal` | POST | access cookie | Polar customer portal |
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
    ├── types.rs     scalar mappings
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
  recentTrains(hours: 1) {
    trainCode
    latitude
    longitude
    direction
    late
  }
}

query StationBoard {
  stationBoard(code: "CNLLY") {
    trainCode
    schArrival
    expArrival
    late
    status
  }
}

# gated to coffee/pro/admin roles
query DelayHistory {
  delayHistory(stationCode: "GLWY", days: 7) {
    bucket
    meanDelayMinutes
    p95DelayMinutes
  }
}
```

### Auth in resolvers

The middleware extracts the access-token cookie into `Option<AuthUser>` on every request, including `/graphql`. `main.rs` forwards that into the GraphQL execution context:

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

## Auth middleware

`auth::middleware::auth_middleware` runs once per request:

1. Read the `access_token` cookie.
2. Verify the JWT against `JWT_SECRET`.
3. Insert `Some(AuthUser { id, email, role })` into request extensions on success, `None` otherwise.

It never rejects. Handlers and resolvers decide whether auth is required.

See [auth-billing.md](auth-billing.md) for token lifetimes, rotation, and cookie flags.

## Environment

The API reads `.env.local` first, then `.env`. Required:

```
DATABASE_URL=postgres://irish_data:secure_password@db:5432/ireland_public
JWT_SECRET=<64 hex chars>
JWT_ACCESS_EXPIRY=900
JWT_REFRESH_EXPIRY=604800
COOKIE_SECURE=true
CORS_ORIGINS=https://traein.semyon.ie
APP_URL=https://traein.semyon.ie
```

Provider-specific keys (Polar or Stripe) are in [auth-billing.md](auth-billing.md).

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
- [chatbot.md](chatbot.md) — how the chatbot wraps GraphQL as MCP tools
- [scraper.md](scraper.md#schema) — the underlying schema being queried
- [data-sources.md](data-sources.md) — upstream field semantics
