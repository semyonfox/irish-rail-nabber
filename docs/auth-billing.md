# Auth and Billing

Sign-in, sign-up and sessions are handled by [Clerk](https://clerk.com). [Polar.sh](https://polar.sh) handles subscriptions as merchant of record and calculates, collects and remits transaction taxes. The Rust API verifies Clerk session tokens, creates Polar checkout sessions and stores the resulting plan role locally.

## Tiers

| Role | Price | Access |
|------|-------|--------|
| `free` | €0 | live map, station list, anonymous GraphQL, 25 000 req/day |
| `coffee` | €5/mo including applicable tax | + analytics, historical queries, 100 000 req/day, chatbot (limited tokens) |
| `pro` | €25/mo including applicable tax | + unlimited requests, priority support |
| `admin` | — | full feature access and unlimited requests |

Tier checks live in three places:

- Per-resolver in the Rust API for paywalled GraphQL fields ([api.md](api.md#auth-in-resolvers)).
- In the Rust `/chat` handler, which rejects `free` before making a model request ([chatbot.md](chatbot.md#rate-limiting-and-cost-control)).
- In the dashboard's `ProtectedRoute` for paid pages ([dashboard.md](dashboard.md#auth-flow)).

The `/auth/*` routes (`config`, `session`, `me`) are outside the daily GraphQL usage quota. The default quota is sized for the polling dashboard:
25,000 requests/day for free accounts and 100,000 requests/day for coffee accounts; pro and admin
roles are unlimited. Deployments can override these values with the existing
`API_RATE_LIMIT_*_TIER_LIMIT` environment variables.

## Schema

```sql
users (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email                    TEXT UNIQUE NOT NULL,
    clerk_user_id            TEXT UNIQUE,               -- clerk "user_..." id
    password_hash            TEXT,                      -- unused since clerk, kept for old rows
    display_name             TEXT,
    role                     TEXT NOT NULL DEFAULT 'free',
    polar_customer_id        TEXT UNIQUE,
    polar_subscription_id    TEXT,
    polar_state_updated_at   TIMESTAMPTZ,
    -- legacy, populated only on accounts migrated from the Stripe era
    stripe_customer_id       TEXT UNIQUE,
    stripe_subscription_id   TEXT,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

The original migration is `migrations/004_add_users_and_auth.sql`; `009_clerk_auth.sql` adds `clerk_user_id` and relaxes `password_hash`. `010_polar_billing.sql` adds the Polar state and a webhook event ledger. The old Stripe columns remain only so the pre-Polar image can still be rolled back.

## Clerk sessions

The dashboard wraps the app in `ClerkProvider` and renders Clerk's `SignIn` / `SignUp` on `/login` and `/register`. It reads the publishable key from `GET /auth/config` at startup (or `VITE_CLERK_PUBLISHABLE_KEY` in dev), because the dashboard's Docker build context ignores `.env` files.

Every API and GraphQL request carries `Authorization: Bearer <clerk session token>`; the `__session` cookie clerk-js keeps on the app origin is accepted as a fallback. The API (`api/src/auth/clerk.rs`):

1. Verifies the RS256 token against the instance JWKS (cached for an hour, refetched at most once a minute for an unknown `kid`), checks `iss`, `exp`/`nbf`, and that `azp` is one of `CORS_ORIGINS` (or `CLERK_AUTHORIZED_PARTIES`).
2. Looks up `users.clerk_user_id = sub`, cached for 60 s.
3. On first sight of a Clerk user, fetches the profile from the Clerk Backend API and either links an existing row with the same **verified** primary email (keeping its role and billing) or creates a new `free` row.

Env:

```
CLERK_PUBLISHABLE_KEY=pk_live_...   # issuer and JWKS url are derived from it
CLERK_SECRET_KEY=sk_live_...        # backend api, only used to provision new users
CLERK_ISSUER=...                    # optional override
CLERK_JWKS_URL=...                  # optional override
CLERK_AUTHORIZED_PARTIES=...        # optional, defaults to CORS_ORIGINS
```

## Endpoints

Auth endpoints (REST, JSON):

| Path | Returns | Notes |
|------|---------|-------|
| `GET /auth/config` | `{ clerk_publishable_key, billing_enabled }` | public |
| `GET /auth/session` | `{ user \| null }` | never 401s |
| `GET /auth/me` | `{ id, email, display_name, role, can_manage_billing, created_at }` | 401 when signed out |

Billing endpoints:

| Path | Body | Returns | Notes |
|------|------|---------|-------|
| `POST /billing/checkout` | `{ plan: "coffee" | "pro" }` | `200 { url }` | product IDs stay server-side |
| `POST /billing/portal` | — | `200 { url }` | self-serve subscription management |
| `POST /billing/webhook` | provider event | `202` | signature-verified |

## Polar.sh flow

```
user clicks plan on /pricing
    POST /billing/checkout { plan }
        api creates Polar checkout session
        api responds with { url }
    browser redirects to Polar-hosted checkout
        user pays
        Polar redirects back to /account?checkout=success
Polar webhook → POST /billing/webhook
    api verifies signature with POLAR_WEBHOOK_SECRET
    customer.state_changed → derive the role from active subscriptions
    duplicate and older events cannot overwrite newer state
```

Role mapping is by product ID, configured via env:

```
POLAR_COFFEE_PRODUCT_ID=...
POLAR_PRO_PRODUCT_ID=...
```

### Polar config (env)

```
POLAR_CHECKOUT_ENABLED=false            # kill switch for new checkout
POLAR_ACCESS_TOKEN=polar_oat_...
POLAR_WEBHOOK_SECRET=whsec_...
POLAR_ORGANIZATION_ID=...
POLAR_COFFEE_PRODUCT_ID=...
POLAR_PRO_PRODUCT_ID=...
POLAR_ENVIRONMENT=production            # or sandbox
```

Coffee and Pro are fixed EUR monthly products. Set each Polar price's tax behavior to `inclusive`, so the customer pays exactly €5 or €25 and Polar extracts the jurisdiction's transaction tax from that total.

The organization access token only needs `checkouts:write` and `customer_sessions:write`. In Settings → Customer portal, enable subscription plan changes, keep Polar email changes off, and use `prorate` as the default: the plan changes immediately and the adjustment lands on the next invoice.

### Why Polar over Stripe

- **Merchant of record.** Polar charges the customer; Polar is responsible for VAT, GST, US sales tax. The project never registers for VAT in another country.
- **EU-friendly invoices** sent to customers automatically.
- **Lower friction at our size.** No accountant-driven VAT MOSS setup, no quarterly filings across jurisdictions.
- Stripe is the bigger ecosystem and remains the right call if/when revenue makes a dedicated tax setup cheap.

## Stripe rollback data

The code and runtime configuration no longer use Stripe. `users.stripe_customer_id` and `users.stripe_subscription_id` remain in the database for compatibility with the tagged pre-Polar API image. Remove them in a later migration after the Polar rollout and rollback window close.

## Security notes

- Passwords, MFA and session lifetime are Clerk's job; the API never sees credentials.
- Session tokens are verified locally against the Clerk JWKS; tokens minted for another origin (`azp`) are rejected.
- Existing accounts are only linked to a Clerk user through a Clerk-verified email address.
- Webhook handlers verify provider signatures before trusting any payload.
- Polar product IDs are mapped to roles on the server. The client can only request `coffee` or `pro`.
- Webhook IDs are recorded transactionally, and event timestamps stop older deliveries from restoring stale access.
- `CLERK_SECRET_KEY` and private `POLAR_*` values belong only in the ignored deployment env file. The tracked `.env.production.example` contains placeholders.
- Until Clerk lifecycle webhooks can reconcile identity changes with Polar, disable end-user email changes and account deletion in Clerk. This prevents a stale billing email or an inaccessible subscription.

## Production setup checklist

1. Clerk dashboard: create a production instance for `traein.semyon.ie`, add the DNS records it lists, then copy its keys into `CLERK_PUBLISHABLE_KEY` / `CLERK_SECRET_KEY`.
2. In Clerk's User & authentication settings, turn off end-user email changes and account deletion until lifecycle syncing is implemented.
3. Polar dashboard: create monthly Coffee (€5) and Pro (€25) products with EUR fixed prices and `inclusive` tax behavior, then copy their IDs.
4. Polar dashboard: create a new raw `customer.state_changed` webhook for `https://traein.semyon.ie/billing/webhook`, then copy its Standard Webhooks signing secret. Do not reuse a legacy pre-2026-09-08 secret.
5. Populate the private server env file (template in [deployment.md](deployment.md#env-template)).
6. Apply migrations with the candidate daemon, verify the Polar columns and webhook ledger exist, then switch the API and dashboard images.
7. Sign up through Clerk and run through checkout in sandbox mode. Confirm the role flips to `coffee`; then revoke the sandbox subscription immediately and confirm it returns to `free`. A normal customer cancellation stays paid until the end of the period.
8. In Polar production, create separate products, a scoped token, and a new webhook endpoint. Replace every sandbox ID/token/secret, set `POLAR_ENVIRONMENT=production`, verify one live checkout, then set `POLAR_CHECKOUT_ENABLED=true` for everyone.

## Related docs

- [api.md](api.md) — endpoint table and middleware
- [dashboard.md](dashboard.md) — pricing/account pages and useAuth hook
- [chatbot.md](chatbot.md) — paid-tier gating for the chat surface
- [deployment.md](deployment.md) — env vars in compose
- `docs/superpowers/specs/2026-03-31-auth-stripe-design.md` — original full design spec
