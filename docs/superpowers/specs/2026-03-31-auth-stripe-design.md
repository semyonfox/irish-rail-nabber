# Auth + Stripe Design Spec

Custom Rust authentication with Stripe subscription billing for irish-rail-nabber.

## Decisions

- **Auth**: Custom email/password in Rust (Axum), no OAuth for now
- **Tokens**: httpOnly cookies, dual-token (access + refresh)
- **Payments**: Stripe Checkout + webhooks + Customer Portal
- **Future**: Architecture should allow swapping to Clerk later without DB migration pain
- **Public vs protected**: GraphQL stays publicly accessible, auth is optional. Individual resolvers enforce authorization for premium features.

## Architecture

```
React SPA (Vite)              Axum API (Rust)                PostgreSQL
┌──────────────────┐         ┌─────────────────────┐       ┌──────────────┐
│ AuthProvider     │─POST──→ │ /auth/register      │──→    │ users        │
│ LoginForm        │─POST──→ │ /auth/login         │──→    │              │
│ RegisterForm     │─POST──→ │ /auth/logout        │       │              │
│                  │─POST──→ │ /auth/refresh       │       │              │
│                  │─GET───→ │ /auth/me            │       │              │
│                  │         │                     │       │              │
│ Pricing page     │─POST──→ │ /billing/checkout   │──→    │ Stripe API   │
│ Account page     │─POST──→ │ /billing/portal     │──→    │              │
│                  │         │ /billing/webhook     │←──    │ (webhooks)   │
│                  │         │                     │       │              │
│ URQL Client      │─POST──→ │ /graphql            │──→    │ trains       │
│ (cookies auto)   │         │  ↳ auth middleware   │       │ stations     │
│                  │         │  ↳ user in context   │       │ etc.         │
└──────────────────┘         └─────────────────────┘       └──────────────┘
```

## Database Schema

Two new tables alongside the existing TimescaleDB schema.

```sql
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT,
    role TEXT NOT NULL DEFAULT 'free',  -- free, coffee, pro, admin
    stripe_customer_id TEXT UNIQUE,
    stripe_subscription_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE refresh_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_stripe_customer ON users(stripe_customer_id);
CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_hash ON refresh_tokens(token_hash);
```

### Roles

| Role     | Price  | Access                                              |
| -------- | ------ | --------------------------------------------------- |
| `free`   | €0     | Live map, station list, 1000 req/day                |
| `coffee` | €5/mo | Above + analytics, historical data, 10k req/day     |
| `pro`    | €25/mo | Unlimited access, raw data export, priority support |
| `admin`  | N/A    | Full access, user management                        |

## Token Strategy

### Access Token (JWT, httpOnly cookie)

- **Lifetime**: 15 minutes
- **Cookie name**: `access_token`
- **Cookie flags**: `httpOnly`, `Secure`, `SameSite=Strict`, `Path=/`
- **JWT claims**: `{ sub: user_id, email, role, exp, iat }`
- **Signing**: HS256 with server secret (env var `JWT_SECRET`)

### Refresh Token (opaque, httpOnly cookie)

- **Lifetime**: 7 days
- **Cookie name**: `refresh_token`
- **Cookie flags**: `httpOnly`, `Secure`, `SameSite=Strict`, `Path=/auth`
- **Storage**: SHA-256 hash stored in `refresh_tokens` table
- **Rotation**: Each refresh issues a new refresh token and invalidates the old one

### CSRF Protection

- `SameSite=Strict` on all cookies prevents cross-origin requests from sending them
- For extra safety on mutations: server generates a CSRF token included in the access token JWT, React reads it from a non-httpOnly `csrf_token` cookie and sends it as `X-CSRF-Token` header on POST requests

## API Endpoints

### Auth Routes

**POST /auth/register**

```
Request:  { email, password, display_name? }
Response: 201 { user: { id, email, display_name, role } }
Cookies:  Set access_token + refresh_token
Errors:   409 email taken, 400 validation (password min 8 chars)
```

**POST /auth/login**

```
Request:  { email, password }
Response: 200 { user: { id, email, display_name, role } }
Cookies:  Set access_token + refresh_token
Errors:   401 invalid credentials (don't reveal which field is wrong)
```

**POST /auth/logout**

```
Auth:     Required (access token)
Response: 200 {}
Cookies:  Clear access_token + refresh_token
Action:   Delete refresh token from DB
```

**POST /auth/refresh**

```
Auth:     Refresh token cookie only
Response: 200 { user: { id, email, display_name, role } }
Cookies:  Set new access_token + new refresh_token
Action:   Rotate refresh token (invalidate old, issue new)
Errors:   401 invalid/expired refresh token
```

**GET /auth/me**

```
Auth:     Required (access token)
Response: 200 { id, email, display_name, role, stripe_customer_id?, created_at }
Errors:   401 not authenticated
```

### Billing Routes

**POST /billing/checkout**

```
Auth:     Required
Request:  { price_id }  -- Stripe price ID for coffee or pro plan
Response: 200 { checkout_url }
Action:   Create Stripe Checkout Session, redirect user to it
```

**POST /billing/portal**

```
Auth:     Required
Response: 200 { portal_url }
Action:   Create Stripe Customer Portal session for managing subscription
```

**POST /billing/webhook**

```
Auth:     Stripe signature verification (no user auth)
Action:   Handle Stripe events:
          - checkout.session.completed → set stripe_customer_id + role
          - customer.subscription.updated → update role based on plan
          - customer.subscription.deleted → downgrade to free
          - invoice.payment_failed → (optional) notify user
```

### GraphQL Changes

No schema changes needed for auth itself. The middleware injects an `Option<User>` into the async-graphql context. Resolvers that need auth check this:

```rust
// in a resolver
fn analytics(&self, ctx: &Context<'_>) -> Result<Analytics> {
    let user = ctx.data::<Option<AuthUser>>()?;
    match user {
        Some(u) if u.role != "free" => { /* serve data */ }
        _ => Err("Pro subscription required".into())
    }
}
```

## Rust Implementation Details

### New Crates

```toml
argon2 = "0.5"           # password hashing
jsonwebtoken = "9"        # JWT encode/decode
uuid = { version = "1", features = ["v4", "serde"] }
rand = "0.8"              # refresh token generation
sha2 = "0.10"             # hash refresh tokens
tower-cookies = "0.10"    # cookie management in Axum
stripe-rust = "0.38"      # Stripe API client (async)
```

### Module Structure

```
api/src/
├── main.rs               # existing, add auth routes
├── auth/
│   ├── mod.rs            # re-exports
│   ├── handlers.rs       # register, login, logout, refresh, me
│   ├── middleware.rs      # JWT extraction + verification layer
│   ├── tokens.rs         # JWT creation, refresh token generation
│   └── password.rs       # argon2 hash + verify
├── billing/
│   ├── mod.rs            # re-exports
│   ├── handlers.rs       # checkout, portal, webhook
│   └── stripe.rs         # Stripe client wrapper
├── db/
│   ├── mod.rs            # existing db module
│   └── users.rs          # user CRUD operations
├── schema/               # existing GraphQL schema
│   └── ...
└── models.rs             # User, AuthUser structs
```

### Auth Middleware Behavior

The middleware runs on every request but does NOT reject unauthenticated ones:

1. Check for `access_token` cookie
2. If present, verify JWT signature and expiry
3. If valid, insert `Some(AuthUser { id, email, role })` into request extensions
4. If absent/invalid, insert `None`
5. Individual handlers/resolvers decide whether auth is required

This keeps the public API working for free-tier users while letting premium resolvers enforce access.

## React Implementation

### New Components

```
dashboard/src/
├── auth/
│   ├── AuthProvider.tsx    # context provider, holds user state
│   ├── useAuth.ts          # hook: user, login(), register(), logout()
│   ├── LoginForm.tsx       # email/password form
│   ├── RegisterForm.tsx    # email/password/name form
│   └── ProtectedRoute.tsx  # wrapper that redirects to login if no user
├── billing/
│   ├── PricingPage.tsx     # plan comparison, checkout buttons
│   └── AccountPage.tsx     # current plan, portal link
├── components/
│   └── Layout.tsx          # existing, add auth buttons to header
└── App.tsx                 # existing, add auth routes
```

### Auth Flow

1. On app load, `AuthProvider` calls `GET /auth/me` to check if user is logged in (cookie exists)
2. If authenticated, stores user in context
3. If not, user sees public content (live map, stations)
4. Login/register forms POST to auth endpoints, cookies set automatically
5. URQL client configured with `credentials: 'include'` so cookies are sent with GraphQL requests
6. On 401 from any endpoint, `AuthProvider` attempts refresh via `/auth/refresh`
7. If refresh fails, clear user state and redirect to login

### New Routes

```tsx
<Routes>
  <Route element={<Layout />}>
    <Route index element={<LiveMap />} /> {/* public */}
    <Route path="stations" element={<Stations />} /> {/* public */}
    <Route path="login" element={<LoginForm />} />
    <Route path="register" element={<RegisterForm />} />
    <Route path="pricing" element={<PricingPage />} />
    <Route
      path="analytics"
      element={
        /* protected */
        <ProtectedRoute>
          <Analytics />
        </ProtectedRoute>
      }
    />
    <Route
      path="account"
      element={
        /* protected */
        <ProtectedRoute>
          <AccountPage />
        </ProtectedRoute>
      }
    />
  </Route>
</Routes>
```

## Environment Variables (new)

```bash
# auth
JWT_SECRET=<random-64-char-string>
JWT_ACCESS_EXPIRY=900          # 15 minutes in seconds
JWT_REFRESH_EXPIRY=604800      # 7 days in seconds

# stripe
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_COFFEE_PRICE_ID=price_...
STRIPE_PRO_PRICE_ID=price_...

# frontend needs to know the stripe publishable key
VITE_STRIPE_PUBLISHABLE_KEY=pk_test_...
```

## Clerk Migration Path

If you swap to Clerk later:

- User table stays, add `clerk_id` column
- Remove `password_hash` column (Clerk manages passwords)
- Remove `refresh_tokens` table
- Replace auth middleware with Clerk JWT verification (JWKS)
- Replace React auth components with `@clerk/clerk-react`
- Stripe integration stays the same (webhook-driven role sync)

The database schema is intentionally simple so migration is a column swap, not a rewrite.

## Security Considerations

- Passwords hashed with argon2id (memory-hard, side-channel resistant)
- Refresh token rotation on every use (prevents replay attacks)
- httpOnly + Secure + SameSite=Strict cookies (XSS and CSRF resistant)
- Generic error messages on login failure ("invalid credentials", never "email not found")
- Rate limiting on auth endpoints (to be added as separate concern, not in this spec)
- Stripe webhook signature verification (prevents spoofed events)
- JWT secret as environment variable, never committed
