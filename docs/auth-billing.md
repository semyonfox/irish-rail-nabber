# Auth and Billing

This branch authenticates with email and password JWTs in `api/src/auth/`. Billing handlers in `api/src/billing/handlers.rs` call Stripe. Migration `004` has Stripe columns and no Polar columns.

The running API binary and the live `users` table are a Clerk and Polar build. See [ARCHITECTURE.md](ARCHITECTURE.md). The Polar sections below describe that intended design. They are not what `handlers.rs` does on this branch.

## Tiers

| Role | Price on `PricingPage.tsx` | What this branch actually gates |
|------|-------|--------|
| `free` | EUR0 | Live map and stations. Default quota 25000 requests a day |
| `coffee` | EUR25/mo | Analytics fields and `/chat`. Default quota 100000 requests a day |
| `pro` | EUR75/mo | Same paid fields as coffee. `rate_limit.rs` treats `pro` and `admin` as unlimited when those roles are in `API_RATE_LIMIT_UNLIMITED_ROLES` |
| `admin` | not listed on the pricing page | Same unlimited default as `pro`. There is no admin user-management route |

`dashboard/src/billing/PricingPage.tsx` shows those three prices. It does not show EUR5 or EUR25 for the paid plans. Chat limits are process-wide environment values in `api/src/chat.rs`. There is no per-role token budget, no CSV or Parquet export, and no admin route in `api/src/main.rs`.

Tier checks in this branch:

- `ensure_premium` in `api/src/schema/analytics.rs` for the paywalled GraphQL fields.
- `chat` in `api/src/chat.rs` returns 401 with no user and 403 for `free`.
- `dashboard/src/auth/ProtectedRoute.tsx` checks that a user exists. It does not read the role. `/history`, `/chat`, and `/account` use it. `/analytics` does not.

Authentication routes are outside the GraphQL rate-limit middleware. Deployments can override the quotas with `API_RATE_LIMIT_FREE_TIER_LIMIT` and `API_RATE_LIMIT_COFFEE_TIER_LIMIT`. The defaults in `api/src/rate_limit.rs` are 25000 and 100000.

## Schema

```sql
users (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email                    TEXT NOT NULL,
    password_hash            TEXT NOT NULL,             -- argon2id
    display_name             TEXT,
    role                     TEXT NOT NULL DEFAULT 'free',
    stripe_customer_id       TEXT UNIQUE,
    stripe_subscription_id   TEXT,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

refresh_tokens (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT NOT NULL,           -- sha256(token)
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

The original migration is `migrations/004_add_users_and_auth.sql`. `email` is not a column unique constraint. That file adds a unique index on `LOWER(email)`. The live `users` table also has Clerk and Polar columns. Those are not in this migration. See [ARCHITECTURE.md](ARCHITECTURE.md).

## Token rotation

Two cookies, both `httpOnly`, both `Secure` in prod, `SameSite=Strict`.

| Cookie | Type | Lifetime | Path |
|--------|------|----------|------|
| `access_token` | JWT (HS256) | 15 min | `/` |
| `refresh_token` | opaque (32 random bytes, hex) | 7 days | `/auth` |

The refresh token is **never stored in plaintext** — only its SHA-256 hash. On each refresh the old token is deleted from `refresh_tokens` and a new one issued (rotation). Logout deletes every refresh token for the user.

JWT claims:

```json
{ "sub": "<uuid>", "email": "...", "role": "free|coffee|pro|admin", "exp": 0, "iat": 0 }
```

`JWT_SECRET` must be 64 random hex chars. Generate with `openssl rand -hex 32`.

## Endpoints

Auth endpoints (REST, JSON):

| Path | Body | Returns | Notes |
|------|------|---------|-------|
| `POST /auth/register` | `{ email, password, display_name? }` | `201` and a flat user object plus cookies | password at least 8 chars |
| `POST /auth/login` | `{ email, password }` | `200` and a flat user object plus cookies | 401 on bad creds |
| `POST /auth/refresh` | refresh cookie | `200` and a flat user object plus rotated cookies | 401 on expired or unknown |
| `POST /auth/logout` | access cookie | `200` with an empty body and cleared cookies | revokes all refresh tokens for the user |
| `GET /auth/me` | access cookie | flat `MeResponse`, including `stripe_customer_id` and `created_at` | not wrapped in `user`, and not `polar_customer_id` |

Billing endpoints:

| Path | Body | Returns | Notes |
|------|------|---------|-------|
| `POST /billing/checkout` | `{ price_id }` | `200 { url }` | redirect user to `url` |
| `POST /billing/portal` | — | `200 { url }` | self-serve subscription management |
| `POST /billing/webhook` | provider event | `200` | signature-verified |

The full spec for cookie flags and CSRF protection lives in `docs/superpowers/specs/2026-03-31-auth-stripe-design.md` (still accurate apart from the provider name).

## Polar.sh flow

```
user clicks plan on /pricing
    POST /billing/checkout { price_id }
        api creates Polar checkout session
        api responds with { url }
    browser redirects to Polar-hosted checkout
        user pays
        Polar redirects back to /account?session_id=...
Polar webhook → POST /billing/webhook
    api verifies signature with POLAR_WEBHOOK_SECRET
    api maps event → user role
        subscription.created / .updated → set role to product mapping
        subscription.cancelled / .past_due → downgrade to free
```

Role mapping is by product ID, configured via env:

```
POLAR_COFFEE_PRODUCT_ID=...
POLAR_PRO_PRODUCT_ID=...
```

### Polar config (env)

```
POLAR_ACCESS_TOKEN=polar_at_...
POLAR_WEBHOOK_SECRET=polar_wh_...
POLAR_ORGANIZATION_ID=...
POLAR_COFFEE_PRODUCT_ID=...
POLAR_PRO_PRODUCT_ID=...
POLAR_ENVIRONMENT=production            # or sandbox
```

### Why Polar over Stripe

- **Merchant of record.** Polar charges the customer; Polar is responsible for VAT, GST, US sales tax. The project never registers for VAT in another country.
- **EU-friendly invoices** sent to customers automatically.
- **Lower friction at our size.** No accountant-driven VAT MOSS setup, no quarterly filings across jurisdictions.
- Stripe is the bigger ecosystem and remains the right call if/when revenue makes a dedicated tax setup cheap.

## Stripe legacy

The codebase still contains a working Stripe implementation:

- `api/src/billing/handlers.rs` — checkout / portal / webhook handlers wired to `async-stripe`.
- `STRIPE_*` env vars in `docker-compose.yml`.
- `users.stripe_customer_id` / `users.stripe_subscription_id` columns.

It can be ripped out cleanly once Polar is live and no production users have an active Stripe subscription:

1. Add `polar_customer_id` / `polar_subscription_id` columns in a new migration alongside the Stripe ones.
2. Reimplement `billing::handlers` against Polar (the `polar-rs` crate or HTTP directly).
3. Update env in `docker-compose.yml` and `.env.local`.
4. Confirm no live Stripe subscriptions, then drop Stripe columns and remove `async-stripe` from `api/Cargo.toml`.

`PricingPage.tsx` reads `VITE_STRIPE_COFFEE_PRICE_ID` and `VITE_STRIPE_PRO_PRICE_ID`. The page is Stripe-specific. It posts to `/billing/checkout`.

## Security notes

- Passwords hashed with `argon2id` (memory-hard, time + memory cost defaults).
- Refresh tokens rotated on every use; a replay of an old refresh token fails the lookup.
- `SameSite=Strict` blocks cross-origin cookie sends; combined with `httpOnly` this protects against most CSRF and XSS-based session theft.
- Login errors are generic — never reveal whether the email or the password was wrong.
- Webhook handlers verify provider signatures before trusting any payload.
- `JWT_SECRET` and `POLAR_*` keys must never be committed; both `.env*` patterns are gitignored.

## Production setup checklist

1. `openssl rand -hex 32` → `JWT_SECRET`.
2. Polar dashboard: create products for Coffee and Pro, copy IDs.
3. Polar dashboard: create webhook for `https://traein.semyon.ie/billing/webhook`, copy signing secret.
4. Populate `.env.local` on the server (template in [deployment.md](deployment.md#env-template)).
5. `docker compose up -d`.
6. Register a test account, run through checkout in sandbox mode, confirm role flips to `coffee` after the webhook.

## Related docs

- [api.md](api.md) — endpoint table and middleware
- [dashboard.md](dashboard.md) — pricing/account pages and useAuth hook
- [chatbot.md](chatbot.md) — paid-tier gating for the chat surface
- [deployment.md](deployment.md) — env vars in compose
- `docs/superpowers/specs/2026-03-31-auth-stripe-design.md` — original full design spec
