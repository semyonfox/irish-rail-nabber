# Auth + Stripe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add custom email/password authentication and Stripe subscription billing to the Rust/React irish-rail-nabber stack.

**Architecture:** Auth endpoints live as REST routes alongside the existing GraphQL endpoint in the Axum server. httpOnly cookies carry access (JWT) and refresh (opaque) tokens. Stripe Checkout handles payments, webhooks sync subscription status to user roles, and Customer Portal enables self-service billing.

**Tech Stack:** Rust (Axum 0.8, argon2, jsonwebtoken, async-stripe), React 19 (URQL, React Router 7), PostgreSQL/TimescaleDB, Stripe Checkout + Customer Portal + Webhooks.

---

## File Structure

### New Rust Files

```
api/src/
├── auth/
│   ├── mod.rs            # module re-exports
│   ├── password.rs       # argon2 hash + verify
│   ├── tokens.rs         # JWT encode/decode, refresh token generation
│   ├── middleware.rs      # cookie extraction, JWT verification, injects AuthUser
│   └── handlers.rs       # register, login, logout, refresh, me endpoints
├── billing/
│   ├── mod.rs            # module re-exports
│   └── handlers.rs       # checkout, portal, webhook endpoints
└── db/
    └── users.rs          # user CRUD, refresh token CRUD
```

### Modified Rust Files

```
api/Cargo.toml            # add auth + stripe dependencies
api/src/main.rs           # add auth/billing routes, middleware, app state
api/src/models.rs         # add User, RefreshToken models
api/src/db.rs             # renamed to db/mod.rs, add users submodule
api/src/schema/mod.rs     # inject AuthUser into GraphQL context
```

### New React Files

```
dashboard/src/
├── auth/
│   ├── AuthProvider.tsx   # context provider, user state, auto-refresh
│   ├── useAuth.ts         # hook returning user + login/register/logout
│   ├── LoginPage.tsx      # login form
│   ├── RegisterPage.tsx   # register form
│   └── ProtectedRoute.tsx # redirects to /login if not authenticated
├── billing/
│   ├── PricingPage.tsx    # plan comparison, checkout buttons
│   └── AccountPage.tsx    # current plan, portal link
└── graphql/
    └── api.ts             # typed fetch wrapper for REST auth/billing endpoints
```

### Modified React Files

```
dashboard/src/App.tsx                # wrap with AuthProvider, add routes
dashboard/src/graphql/client.ts      # add credentials: 'include'
dashboard/src/components/Layout.tsx   # add auth buttons to header
dashboard/package.json               # no new deps needed (fetch is native)
```

### New Infrastructure Files

```
migrations/004_add_users_and_auth.sql  # users + refresh_tokens tables
```

### Modified Infrastructure Files

```
docker-compose.yml   # add auth + stripe env vars
.gitignore           # already ignores .env*
```

---

## Task 1: Database Migration

Add users and refresh_tokens tables.

**Files:**

- Create: `migrations/004_add_users_and_auth.sql`

- [ ] **Step 1: Create the migration file**

```sql
-- users and auth tables for custom authentication
-- run against the ireland_public database

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT,
    role TEXT NOT NULL DEFAULT 'free',
    stripe_customer_id TEXT UNIQUE,
    stripe_subscription_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_stripe_customer ON users(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash);

-- auto-update updated_at on users
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();
```

- [ ] **Step 2: Apply the migration**

Run: `docker exec -i irish-rail-nabber-db-1 psql -U irish_data -d ireland_public < migrations/004_add_users_and_auth.sql`

Expected: Tables created without errors. Verify with:

```bash
docker exec irish-rail-nabber-db-1 psql -U irish_data -d ireland_public -c "\dt users" -c "\dt refresh_tokens"
```

- [ ] **Step 3: Commit**

```bash
git add migrations/004_add_users_and_auth.sql
git commit -m "add users and refresh_tokens tables for auth"
```

---

## Task 2: Update Cargo.toml with Auth + Stripe Dependencies

**Files:**

- Modify: `api/Cargo.toml`

- [ ] **Step 1: Add dependencies**

Add these lines to the `[dependencies]` section of `api/Cargo.toml` (after the existing `tracing-subscriber` line):

```toml
argon2 = "0.5"
jsonwebtoken = "9"
uuid = { version = "1", features = ["v4", "serde"] }
rand = "0.9"
sha2 = "0.10"
hex = "0.4"
axum-extra = { version = "0.10", features = ["cookie"] }
cookie = "0.18"
async-stripe = { version = "0.39", features = ["runtime-tokio-hyper"] }
serde_json = "1"
```

Also add `uuid` feature to the existing `sqlx` line. Change:

```toml
sqlx = { version = "0.8", features = ["runtime-tokio", "postgres", "chrono", "bigdecimal", "time"] }
```

to:

```toml
sqlx = { version = "0.8", features = ["runtime-tokio", "postgres", "chrono", "bigdecimal", "time", "uuid"] }
```

- [ ] **Step 2: Verify it compiles**

Run: `cargo check` (from `api/` directory)

Expected: Should compile with no errors (just unused import warnings is fine at this stage).

- [ ] **Step 3: Commit**

```bash
git add api/Cargo.toml
git commit -m "add auth and stripe dependencies"
```

---

## Task 3: Auth Models

Add User and auth-related structs.

**Files:**

- Modify: `api/src/models.rs` (append to end)

- [ ] **Step 1: Add auth model structs**

Append to `api/src/models.rs` after the existing `FetchHistoryRow` struct (after line 85):

```rust
// auth models

#[derive(sqlx::FromRow, Debug, Clone)]
pub struct UserRow {
    pub id: uuid::Uuid,
    pub email: String,
    pub password_hash: String,
    pub display_name: Option<String>,
    pub role: String,
    pub stripe_customer_id: Option<String>,
    pub stripe_subscription_id: Option<String>,
    pub created_at: NaiveDateTime,
    pub updated_at: NaiveDateTime,
}

#[derive(sqlx::FromRow, Debug)]
pub struct RefreshTokenRow {
    pub id: uuid::Uuid,
    pub user_id: uuid::Uuid,
    pub token_hash: String,
    pub expires_at: NaiveDateTime,
    pub created_at: NaiveDateTime,
}

/// lightweight user info extracted from JWT, injected into request extensions
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AuthUser {
    pub id: uuid::Uuid,
    pub email: String,
    pub role: String,
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cargo check` (from `api/` directory)

Expected: Compiles (warnings about unused structs are fine).

- [ ] **Step 3: Commit**

```bash
git add api/src/models.rs
git commit -m "add auth model structs"
```

---

## Task 4: Password Hashing Module

**Files:**

- Create: `api/src/auth/mod.rs`
- Create: `api/src/auth/password.rs`

- [ ] **Step 1: Create auth module file**

Create `api/src/auth/mod.rs`:

```rust
pub mod password;
pub mod tokens;
pub mod middleware;
pub mod handlers;
```

- [ ] **Step 2: Create password module**

Create `api/src/auth/password.rs`:

```rust
use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};

pub fn hash_password(password: &str) -> Result<String, argon2::password_hash::Error> {
    let salt = SaltString::generate(&mut OsRng);
    let argon2 = Argon2::default();
    let hash = argon2.hash_password(password.as_bytes(), &salt)?;
    Ok(hash.to_string())
}

pub fn verify_password(password: &str, hash: &str) -> bool {
    let Ok(parsed_hash) = PasswordHash::new(hash) else {
        return false;
    };
    Argon2::default()
        .verify_password(password.as_bytes(), &parsed_hash)
        .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_and_verify() {
        let hash = hash_password("test_password_123").unwrap();
        assert!(verify_password("test_password_123", &hash));
        assert!(!verify_password("wrong_password", &hash));
    }

    #[test]
    fn different_salts() {
        let h1 = hash_password("same").unwrap();
        let h2 = hash_password("same").unwrap();
        assert_ne!(h1, h2); // different salts
        assert!(verify_password("same", &h1));
        assert!(verify_password("same", &h2));
    }
}
```

- [ ] **Step 3: Register the auth module in main.rs**

Add `mod auth;` to the top of `api/src/main.rs` (after the existing `mod schema;` on line 3):

```rust
mod db;
mod models;
mod schema;
mod auth;
```

- [ ] **Step 4: Run the tests**

Run: `cargo test -p irish-rail-api auth::password` (from `api/` directory)

Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add api/src/auth/
git commit -m "add password hashing with argon2"
```

---

## Task 5: JWT Token Module

**Files:**

- Create: `api/src/auth/tokens.rs`

- [ ] **Step 1: Create tokens module**

Create `api/src/auth/tokens.rs`:

```rust
use chrono::{Duration, Utc};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: Uuid,       // user id
    pub email: String,
    pub role: String,
    pub exp: i64,        // expiry (unix timestamp)
    pub iat: i64,        // issued at
}

pub fn create_access_token(
    user_id: Uuid,
    email: &str,
    role: &str,
    secret: &str,
    expiry_secs: i64,
) -> Result<String, jsonwebtoken::errors::Error> {
    let now = Utc::now();
    let claims = Claims {
        sub: user_id,
        email: email.to_string(),
        role: role.to_string(),
        exp: (now + Duration::seconds(expiry_secs)).timestamp(),
        iat: now.timestamp(),
    };
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
}

pub fn verify_access_token(
    token: &str,
    secret: &str,
) -> Result<Claims, jsonwebtoken::errors::Error> {
    let token_data = decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &Validation::default(),
    )?;
    Ok(token_data.claims)
}

/// generate a random opaque refresh token (returned to client as cookie)
pub fn generate_refresh_token() -> String {
    let bytes: [u8; 32] = rand::random();
    hex::encode(bytes)
}

/// hash a refresh token for storage (never store the raw token)
pub fn hash_refresh_token(token: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    hex::encode(hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_and_verify_token() {
        let id = Uuid::new_v4();
        let token = create_access_token(id, "test@example.com", "free", "test_secret", 300).unwrap();
        let claims = verify_access_token(&token, "test_secret").unwrap();
        assert_eq!(claims.sub, id);
        assert_eq!(claims.email, "test@example.com");
        assert_eq!(claims.role, "free");
    }

    #[test]
    fn expired_token_fails() {
        let id = Uuid::new_v4();
        // create a token that expired 10 seconds ago
        let token = create_access_token(id, "test@example.com", "free", "test_secret", -10).unwrap();
        assert!(verify_access_token(&token, "test_secret").is_err());
    }

    #[test]
    fn wrong_secret_fails() {
        let id = Uuid::new_v4();
        let token = create_access_token(id, "test@example.com", "free", "secret_a", 300).unwrap();
        assert!(verify_access_token(&token, "secret_b").is_err());
    }

    #[test]
    fn refresh_token_hash_is_deterministic() {
        let token = "abc123";
        assert_eq!(hash_refresh_token(token), hash_refresh_token(token));
    }

    #[test]
    fn refresh_tokens_are_unique() {
        let a = generate_refresh_token();
        let b = generate_refresh_token();
        assert_ne!(a, b);
    }
}
```

- [ ] **Step 2: Run the tests**

Run: `cargo test -p irish-rail-api auth::tokens` (from `api/` directory)

Expected: 5 tests pass.

- [ ] **Step 3: Commit**

```bash
git add api/src/auth/tokens.rs
git commit -m "add JWT and refresh token utilities"
```

---

## Task 6: User Database Operations

Restructure `db.rs` into a `db/` module and add user CRUD.

**Files:**

- Move: `api/src/db.rs` → `api/src/db/mod.rs`
- Create: `api/src/db/users.rs`

- [ ] **Step 1: Convert db.rs to db/mod.rs**

Create directory `api/src/db/`, move `api/src/db.rs` to `api/src/db/mod.rs`, and add the users submodule:

```bash
mkdir -p api/src/db
mv api/src/db.rs api/src/db/mod.rs
```

Then add to the top of `api/src/db/mod.rs`:

```rust
pub mod users;

use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;

pub async fn create_pool() -> PgPool {
    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://irish_data:secure_password@server:9898/ireland_public".to_string());

    PgPoolOptions::new()
        .max_connections(10)
        .acquire_timeout(std::time::Duration::from_secs(30))
        .connect(&database_url)
        .await
        .expect("failed to connect to database")
}
```

- [ ] **Step 2: Create users database module**

Create `api/src/db/users.rs`:

```rust
use chrono::NaiveDateTime;
use sqlx::PgPool;
use uuid::Uuid;

use crate::models::{UserRow, RefreshTokenRow};

// -- user operations --

pub async fn create_user(
    pool: &PgPool,
    email: &str,
    password_hash: &str,
    display_name: Option<&str>,
) -> Result<UserRow, sqlx::Error> {
    sqlx::query_as::<_, UserRow>(
        "INSERT INTO users (email, password_hash, display_name)
         VALUES ($1, $2, $3)
         RETURNING id, email, password_hash, display_name, role,
                   stripe_customer_id, stripe_subscription_id, created_at, updated_at"
    )
    .bind(email)
    .bind(password_hash)
    .bind(display_name)
    .fetch_one(pool)
    .await
}

pub async fn find_user_by_email(pool: &PgPool, email: &str) -> Result<Option<UserRow>, sqlx::Error> {
    sqlx::query_as::<_, UserRow>(
        "SELECT id, email, password_hash, display_name, role,
                stripe_customer_id, stripe_subscription_id, created_at, updated_at
         FROM users WHERE email = $1"
    )
    .bind(email)
    .fetch_optional(pool)
    .await
}

pub async fn find_user_by_id(pool: &PgPool, id: Uuid) -> Result<Option<UserRow>, sqlx::Error> {
    sqlx::query_as::<_, UserRow>(
        "SELECT id, email, password_hash, display_name, role,
                stripe_customer_id, stripe_subscription_id, created_at, updated_at
         FROM users WHERE id = $1"
    )
    .bind(id)
    .fetch_optional(pool)
    .await
}

pub async fn update_user_stripe(
    pool: &PgPool,
    user_id: Uuid,
    stripe_customer_id: &str,
    stripe_subscription_id: Option<&str>,
    role: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE users SET stripe_customer_id = $2, stripe_subscription_id = $3, role = $4
         WHERE id = $1"
    )
    .bind(user_id)
    .bind(stripe_customer_id)
    .bind(stripe_subscription_id)
    .bind(role)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn update_user_role(pool: &PgPool, stripe_customer_id: &str, role: &str) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE users SET role = $2 WHERE stripe_customer_id = $1")
        .bind(stripe_customer_id)
        .bind(role)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn find_user_by_stripe_customer(
    pool: &PgPool,
    stripe_customer_id: &str,
) -> Result<Option<UserRow>, sqlx::Error> {
    sqlx::query_as::<_, UserRow>(
        "SELECT id, email, password_hash, display_name, role,
                stripe_customer_id, stripe_subscription_id, created_at, updated_at
         FROM users WHERE stripe_customer_id = $1"
    )
    .bind(stripe_customer_id)
    .fetch_optional(pool)
    .await
}

// -- refresh token operations --

pub async fn store_refresh_token(
    pool: &PgPool,
    user_id: Uuid,
    token_hash: &str,
    expires_at: NaiveDateTime,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)"
    )
    .bind(user_id)
    .bind(token_hash)
    .bind(expires_at)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn find_refresh_token(
    pool: &PgPool,
    token_hash: &str,
) -> Result<Option<RefreshTokenRow>, sqlx::Error> {
    sqlx::query_as::<_, RefreshTokenRow>(
        "SELECT id, user_id, token_hash, expires_at, created_at
         FROM refresh_tokens WHERE token_hash = $1"
    )
    .bind(token_hash)
    .fetch_optional(pool)
    .await
}

pub async fn delete_refresh_token(pool: &PgPool, token_hash: &str) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM refresh_tokens WHERE token_hash = $1")
        .bind(token_hash)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn delete_user_refresh_tokens(pool: &PgPool, user_id: Uuid) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM refresh_tokens WHERE user_id = $1")
        .bind(user_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn cleanup_expired_tokens(pool: &PgPool) -> Result<u64, sqlx::Error> {
    let result = sqlx::query("DELETE FROM refresh_tokens WHERE expires_at < NOW()")
        .execute(pool)
        .await?;
    Ok(result.rows_affected())
}
```

- [ ] **Step 3: Verify it compiles**

Run: `cargo check` (from `api/` directory)

Expected: Compiles (unused function warnings are fine).

- [ ] **Step 4: Commit**

```bash
git add api/src/db/
git commit -m "restructure db module, add user and refresh token operations"
```

---

## Task 7: App State and Auth Middleware

Create shared app state and the JWT extraction middleware.

**Files:**

- Create: `api/src/auth/middleware.rs`
- Modify: `api/src/main.rs` (add AppState)

- [ ] **Step 1: Create auth middleware**

Create `api/src/auth/middleware.rs`:

```rust
use axum::{
    extract::Request,
    middleware::Next,
    response::Response,
};
use axum_extra::extract::CookieJar;

use crate::auth::tokens;
use crate::models::AuthUser;

/// extracts the access_token cookie, verifies the JWT, and inserts
/// Option<AuthUser> into request extensions. does NOT reject
/// unauthenticated requests -- individual handlers check for auth.
pub async fn auth_middleware(
    jar: CookieJar,
    mut req: Request,
    next: Next,
) -> Response {
    let auth_user = jar
        .get("access_token")
        .and_then(|cookie| {
            let secret = std::env::var("JWT_SECRET").unwrap_or_default();
            tokens::verify_access_token(cookie.value(), &secret).ok()
        })
        .map(|claims| AuthUser {
            id: claims.sub,
            email: claims.email,
            role: claims.role,
        });

    req.extensions_mut().insert(auth_user);
    next.run(req).await
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cargo check` (from `api/` directory)

Expected: Compiles.

- [ ] **Step 3: Commit**

```bash
git add api/src/auth/middleware.rs
git commit -m "add auth middleware for JWT extraction from cookies"
```

---

## Task 8: Auth Handlers

Register, login, logout, refresh, and me endpoints.

**Files:**

- Create: `api/src/auth/handlers.rs`

- [ ] **Step 1: Create auth handlers**

Create `api/src/auth/handlers.rs`:

```rust
use axum::{
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use axum_extra::extract::CookieJar;
use cookie::time::Duration as CookieDuration;
use cookie::{Cookie, SameSite};
use chrono::{Duration, Utc};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;

use crate::auth::{password, tokens};
use crate::db::users;
use crate::models::AuthUser;

#[derive(Deserialize)]
pub struct RegisterRequest {
    pub email: String,
    pub password: String,
    pub display_name: Option<String>,
}

#[derive(Deserialize)]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
}

#[derive(Serialize)]
pub struct UserResponse {
    pub id: String,
    pub email: String,
    pub display_name: Option<String>,
    pub role: String,
}

#[derive(Serialize)]
pub struct MeResponse {
    pub id: String,
    pub email: String,
    pub display_name: Option<String>,
    pub role: String,
    pub stripe_customer_id: Option<String>,
    pub created_at: String,
}

#[derive(Serialize)]
struct ErrorResponse {
    error: String,
}

fn jwt_secret() -> String {
    std::env::var("JWT_SECRET").expect("JWT_SECRET must be set")
}

fn access_expiry() -> i64 {
    std::env::var("JWT_ACCESS_EXPIRY")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(900) // 15 minutes
}

fn refresh_expiry() -> i64 {
    std::env::var("JWT_REFRESH_EXPIRY")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(604800) // 7 days
}

fn is_secure() -> bool {
    // disable Secure flag in development (no HTTPS on localhost)
    std::env::var("COOKIE_SECURE")
        .map(|v| v == "true" || v == "1")
        .unwrap_or(false)
}

fn build_access_cookie(token: &str) -> Cookie<'static> {
    let mut cookie = Cookie::build(("access_token", token.to_string()))
        .http_only(true)
        .same_site(SameSite::Strict)
        .path("/")
        .max_age(CookieDuration::seconds(access_expiry()))
        .build();
    cookie.set_secure(is_secure());
    cookie
}

fn build_refresh_cookie(token: &str) -> Cookie<'static> {
    let mut cookie = Cookie::build(("refresh_token", token.to_string()))
        .http_only(true)
        .same_site(SameSite::Strict)
        .path("/auth")
        .max_age(CookieDuration::seconds(refresh_expiry()))
        .build();
    cookie.set_secure(is_secure());
    cookie
}

fn clear_access_cookie() -> Cookie<'static> {
    let mut cookie = Cookie::build(("access_token", ""))
        .http_only(true)
        .same_site(SameSite::Strict)
        .path("/")
        .max_age(CookieDuration::ZERO)
        .build();
    cookie.set_secure(is_secure());
    cookie
}

fn clear_refresh_cookie() -> Cookie<'static> {
    let mut cookie = Cookie::build(("refresh_token", ""))
        .http_only(true)
        .same_site(SameSite::Strict)
        .path("/auth")
        .max_age(CookieDuration::ZERO)
        .build();
    cookie.set_secure(is_secure());
    cookie
}

fn err(status: StatusCode, msg: &str) -> (StatusCode, Json<ErrorResponse>) {
    (status, Json(ErrorResponse { error: msg.to_string() }))
}

// POST /auth/register
pub async fn register(
    State(pool): State<PgPool>,
    jar: CookieJar,
    Json(body): Json<RegisterRequest>,
) -> Result<(CookieJar, (StatusCode, Json<UserResponse>)), (StatusCode, Json<ErrorResponse>)> {
    // validate
    let email = body.email.trim().to_lowercase();
    if email.is_empty() || !email.contains('@') {
        return Err(err(StatusCode::BAD_REQUEST, "invalid email"));
    }
    if body.password.len() < 8 {
        return Err(err(StatusCode::BAD_REQUEST, "password must be at least 8 characters"));
    }

    // check existing
    let existing = users::find_user_by_email(&pool, &email)
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "database error"))?;
    if existing.is_some() {
        return Err(err(StatusCode::CONFLICT, "email already registered"));
    }

    // hash password
    let hash = password::hash_password(&body.password)
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "failed to hash password"))?;

    // create user
    let user = users::create_user(&pool, &email, &hash, body.display_name.as_deref())
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "failed to create user"))?;

    // create tokens
    let access = tokens::create_access_token(user.id, &user.email, &user.role, &jwt_secret(), access_expiry())
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "failed to create token"))?;

    let refresh = tokens::generate_refresh_token();
    let refresh_hash = tokens::hash_refresh_token(&refresh);
    let refresh_expires = (Utc::now() + Duration::seconds(refresh_expiry())).naive_utc();

    users::store_refresh_token(&pool, user.id, &refresh_hash, refresh_expires)
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "failed to store refresh token"))?;

    let jar = jar
        .add(build_access_cookie(&access))
        .add(build_refresh_cookie(&refresh));

    Ok((jar, (StatusCode::CREATED, Json(UserResponse {
        id: user.id.to_string(),
        email: user.email,
        display_name: user.display_name,
        role: user.role,
    }))))
}

// POST /auth/login
pub async fn login(
    State(pool): State<PgPool>,
    jar: CookieJar,
    Json(body): Json<LoginRequest>,
) -> Result<(CookieJar, Json<UserResponse>), (StatusCode, Json<ErrorResponse>)> {
    let email = body.email.trim().to_lowercase();

    let user = users::find_user_by_email(&pool, &email)
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "database error"))?
        .ok_or_else(|| err(StatusCode::UNAUTHORIZED, "invalid credentials"))?;

    if !password::verify_password(&body.password, &user.password_hash) {
        return Err(err(StatusCode::UNAUTHORIZED, "invalid credentials"));
    }

    let access = tokens::create_access_token(user.id, &user.email, &user.role, &jwt_secret(), access_expiry())
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "failed to create token"))?;

    let refresh = tokens::generate_refresh_token();
    let refresh_hash = tokens::hash_refresh_token(&refresh);
    let refresh_expires = (Utc::now() + Duration::seconds(refresh_expiry())).naive_utc();

    users::store_refresh_token(&pool, user.id, &refresh_hash, refresh_expires)
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "failed to store refresh token"))?;

    let jar = jar
        .add(build_access_cookie(&access))
        .add(build_refresh_cookie(&refresh));

    Ok((jar, Json(UserResponse {
        id: user.id.to_string(),
        email: user.email,
        display_name: user.display_name,
        role: user.role,
    })))
}

// POST /auth/logout
pub async fn logout(
    State(pool): State<PgPool>,
    jar: CookieJar,
    req: axum::extract::Request,
) -> Result<CookieJar, (StatusCode, Json<ErrorResponse>)> {
    let auth_user = req.extensions().get::<Option<AuthUser>>()
        .and_then(|u| u.as_ref())
        .ok_or_else(|| err(StatusCode::UNAUTHORIZED, "not authenticated"))?;

    // revoke all refresh tokens for this user
    users::delete_user_refresh_tokens(&pool, auth_user.id)
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "failed to revoke tokens"))?;

    let jar = jar
        .add(clear_access_cookie())
        .add(clear_refresh_cookie());

    Ok(jar)
}

// POST /auth/refresh
pub async fn refresh(
    State(pool): State<PgPool>,
    jar: CookieJar,
) -> Result<(CookieJar, Json<UserResponse>), (StatusCode, Json<ErrorResponse>)> {
    let refresh_cookie = jar.get("refresh_token")
        .ok_or_else(|| err(StatusCode::UNAUTHORIZED, "no refresh token"))?;

    let token_hash = tokens::hash_refresh_token(refresh_cookie.value());

    // find and validate the refresh token
    let stored = users::find_refresh_token(&pool, &token_hash)
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "database error"))?
        .ok_or_else(|| err(StatusCode::UNAUTHORIZED, "invalid refresh token"))?;

    if stored.expires_at < Utc::now().naive_utc() {
        // expired, clean it up
        let _ = users::delete_refresh_token(&pool, &token_hash).await;
        return Err(err(StatusCode::UNAUTHORIZED, "refresh token expired"));
    }

    // get the user
    let user = users::find_user_by_id(&pool, stored.user_id)
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "database error"))?
        .ok_or_else(|| err(StatusCode::UNAUTHORIZED, "user not found"))?;

    // rotate: delete old, create new
    users::delete_refresh_token(&pool, &token_hash)
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "failed to rotate token"))?;

    let new_access = tokens::create_access_token(user.id, &user.email, &user.role, &jwt_secret(), access_expiry())
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "failed to create token"))?;

    let new_refresh = tokens::generate_refresh_token();
    let new_refresh_hash = tokens::hash_refresh_token(&new_refresh);
    let new_expires = (Utc::now() + Duration::seconds(refresh_expiry())).naive_utc();

    users::store_refresh_token(&pool, user.id, &new_refresh_hash, new_expires)
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "failed to store refresh token"))?;

    let jar = jar
        .add(build_access_cookie(&new_access))
        .add(build_refresh_cookie(&new_refresh));

    Ok((jar, Json(UserResponse {
        id: user.id.to_string(),
        email: user.email,
        display_name: user.display_name,
        role: user.role,
    })))
}

// GET /auth/me
pub async fn me(
    State(pool): State<PgPool>,
    req: axum::extract::Request,
) -> Result<Json<MeResponse>, (StatusCode, Json<ErrorResponse>)> {
    let auth_user = req.extensions().get::<Option<AuthUser>>()
        .and_then(|u| u.as_ref())
        .ok_or_else(|| err(StatusCode::UNAUTHORIZED, "not authenticated"))?;

    let user = users::find_user_by_id(&pool, auth_user.id)
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "database error"))?
        .ok_or_else(|| err(StatusCode::UNAUTHORIZED, "user not found"))?;

    Ok(Json(MeResponse {
        id: user.id.to_string(),
        email: user.email,
        display_name: user.display_name,
        role: user.role,
        stripe_customer_id: user.stripe_customer_id,
        created_at: user.created_at.format("%Y-%m-%dT%H:%M:%S").to_string(),
    }))
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cargo check` (from `api/` directory)

Expected: Compiles.

- [ ] **Step 3: Commit**

```bash
git add api/src/auth/handlers.rs
git commit -m "add auth handlers: register, login, logout, refresh, me"
```

---

## Task 9: Billing Handlers (Stripe)

**Files:**

- Create: `api/src/billing/mod.rs`
- Create: `api/src/billing/handlers.rs`

- [ ] **Step 1: Create billing module**

Create `api/src/billing/mod.rs`:

```rust
pub mod handlers;
```

- [ ] **Step 2: Create billing handlers**

Create `api/src/billing/handlers.rs`:

```rust
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use stripe::{
    CheckoutSession, CheckoutSessionMode, Client as StripeClient,
    CreateCheckoutSession, CreateCheckoutSessionLineItems,
    CreateBillingPortalSession, BillingPortalSession,
    CustomerId, Webhook,
};

use crate::db::users;
use crate::models::AuthUser;

#[derive(Deserialize)]
pub struct CheckoutRequest {
    pub price_id: String,
}

#[derive(Serialize)]
pub struct UrlResponse {
    pub url: String,
}

#[derive(Serialize)]
struct ErrorResponse {
    error: String,
}

fn stripe_client() -> StripeClient {
    let key = std::env::var("STRIPE_SECRET_KEY").expect("STRIPE_SECRET_KEY must be set");
    StripeClient::new(key)
}

fn webhook_secret() -> String {
    std::env::var("STRIPE_WEBHOOK_SECRET").expect("STRIPE_WEBHOOK_SECRET must be set")
}

fn err(status: StatusCode, msg: &str) -> (StatusCode, Json<ErrorResponse>) {
    (status, Json(ErrorResponse { error: msg.to_string() }))
}

// POST /billing/checkout
pub async fn checkout(
    State(pool): State<PgPool>,
    req: axum::extract::Request,
    Json(body): Json<CheckoutRequest>,
) -> Result<Json<UrlResponse>, (StatusCode, Json<ErrorResponse>)> {
    let auth_user = req.extensions().get::<Option<AuthUser>>()
        .and_then(|u| u.as_ref())
        .ok_or_else(|| err(StatusCode::UNAUTHORIZED, "not authenticated"))?
        .clone();

    let user = users::find_user_by_id(&pool, auth_user.id)
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "database error"))?
        .ok_or_else(|| err(StatusCode::UNAUTHORIZED, "user not found"))?;

    let client = stripe_client();
    let app_url = std::env::var("APP_URL").unwrap_or_else(|_| "http://localhost:3000".to_string());

    let mut params = CreateCheckoutSession::new();
    params.mode = Some(CheckoutSessionMode::Subscription);
    params.success_url = Some(&format!("{}/account?session_id={{CHECKOUT_SESSION_ID}}", app_url));
    params.cancel_url = Some(&format!("{}/pricing", app_url));
    params.line_items = Some(vec![CreateCheckoutSessionLineItems {
        price: Some(body.price_id.clone()),
        quantity: Some(1),
        ..Default::default()
    }]);
    params.client_reference_id = Some(&user.id.to_string());

    // if user already has a stripe customer, reuse it
    if let Some(ref cid) = user.stripe_customer_id {
        params.customer = Some(cid.parse::<CustomerId>().unwrap());
    } else {
        params.customer_email = Some(&user.email);
    }

    let session = CheckoutSession::create(&client, params)
        .await
        .map_err(|e| {
            tracing::error!("stripe checkout error: {}", e);
            err(StatusCode::INTERNAL_SERVER_ERROR, "failed to create checkout session")
        })?;

    let url = session.url
        .ok_or_else(|| err(StatusCode::INTERNAL_SERVER_ERROR, "no checkout URL returned"))?;

    Ok(Json(UrlResponse { url }))
}

// POST /billing/portal
pub async fn portal(
    State(pool): State<PgPool>,
    req: axum::extract::Request,
) -> Result<Json<UrlResponse>, (StatusCode, Json<ErrorResponse>)> {
    let auth_user = req.extensions().get::<Option<AuthUser>>()
        .and_then(|u| u.as_ref())
        .ok_or_else(|| err(StatusCode::UNAUTHORIZED, "not authenticated"))?
        .clone();

    let user = users::find_user_by_id(&pool, auth_user.id)
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "database error"))?
        .ok_or_else(|| err(StatusCode::UNAUTHORIZED, "user not found"))?;

    let stripe_customer_id = user.stripe_customer_id
        .ok_or_else(|| err(StatusCode::BAD_REQUEST, "no stripe subscription"))?;

    let client = stripe_client();
    let app_url = std::env::var("APP_URL").unwrap_or_else(|_| "http://localhost:3000".to_string());

    let mut params = CreateBillingPortalSession::new(stripe_customer_id.parse::<CustomerId>().unwrap());
    params.return_url = Some(&format!("{}/account", app_url));

    let session = BillingPortalSession::create(&client, params)
        .await
        .map_err(|e| {
            tracing::error!("stripe portal error: {}", e);
            err(StatusCode::INTERNAL_SERVER_ERROR, "failed to create portal session")
        })?;

    Ok(Json(UrlResponse { url: session.url }))
}

/// maps a stripe price ID to a user role
fn price_to_role(price_id: &str) -> &str {
    let coffee_price = std::env::var("STRIPE_COFFEE_PRICE_ID").unwrap_or_default();
    let pro_price = std::env::var("STRIPE_PRO_PRICE_ID").unwrap_or_default();

    if price_id == coffee_price {
        "coffee"
    } else if price_id == pro_price {
        "pro"
    } else {
        "free"
    }
}

// POST /billing/webhook
pub async fn webhook(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    body: String,
) -> impl IntoResponse {
    let sig = headers
        .get("stripe-signature")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    let event = match Webhook::construct_event(&body, sig, &webhook_secret()) {
        Ok(event) => event,
        Err(e) => {
            tracing::warn!("webhook signature verification failed: {}", e);
            return StatusCode::BAD_REQUEST;
        }
    };

    tracing::info!("stripe webhook: {}", event.type_);

    match event.type_.as_str() {
        "checkout.session.completed" => {
            if let Ok(session) = serde_json::from_value::<CheckoutSession>(event.data.object) {
                handle_checkout_completed(&pool, session).await;
            }
        }
        "customer.subscription.updated" => {
            if let Ok(sub) = serde_json::from_value::<stripe::Subscription>(event.data.object) {
                handle_subscription_updated(&pool, sub).await;
            }
        }
        "customer.subscription.deleted" => {
            if let Ok(sub) = serde_json::from_value::<stripe::Subscription>(event.data.object) {
                handle_subscription_deleted(&pool, sub).await;
            }
        }
        _ => {
            tracing::debug!("unhandled webhook event: {}", event.type_);
        }
    }

    StatusCode::OK
}

async fn handle_checkout_completed(pool: &PgPool, session: CheckoutSession) {
    let Some(customer_id) = session.customer.map(|c| c.id().to_string()) else {
        tracing::warn!("checkout session has no customer");
        return;
    };

    let Some(sub_id) = session.subscription.map(|s| s.id().to_string()) else {
        tracing::warn!("checkout session has no subscription");
        return;
    };

    // get user by client_reference_id (user UUID we set during checkout)
    let Some(ref user_id_str) = session.client_reference_id else {
        tracing::warn!("checkout session has no client_reference_id");
        return;
    };

    let Ok(user_id) = user_id_str.parse::<uuid::Uuid>() else {
        tracing::warn!("invalid user id in client_reference_id: {}", user_id_str);
        return;
    };

    // determine role from the subscription's price
    let role = "coffee"; // default; will be corrected on subscription.updated

    if let Err(e) = users::update_user_stripe(pool, user_id, &customer_id, Some(&sub_id), role).await {
        tracing::error!("failed to update user stripe info: {}", e);
    }
}

async fn handle_subscription_updated(pool: &PgPool, sub: stripe::Subscription) {
    let customer_id = sub.customer.id().to_string();

    // get the price from the first item
    let role = sub.items.data.first()
        .and_then(|item| item.price.as_ref())
        .map(|price| price_to_role(&price.id.to_string()))
        .unwrap_or("free");

    if let Err(e) = users::update_user_role(pool, &customer_id, role).await {
        tracing::error!("failed to update user role: {}", e);
    }
}

async fn handle_subscription_deleted(pool: &PgPool, sub: stripe::Subscription) {
    let customer_id = sub.customer.id().to_string();

    if let Err(e) = users::update_user_role(pool, &customer_id, "free").await {
        tracing::error!("failed to downgrade user: {}", e);
    }
}
```

- [ ] **Step 3: Register billing module in main.rs**

Add `mod billing;` to the top of `api/src/main.rs`:

```rust
mod db;
mod models;
mod schema;
mod auth;
mod billing;
```

- [ ] **Step 4: Verify it compiles**

Run: `cargo check` (from `api/` directory)

Expected: Compiles. The Stripe types may need adjustment depending on the exact `async-stripe` version -- check for type errors and fix any mismatches with the actual API. Common issues: `customer` might be an `Expandable<Customer>` that needs `.id()` vs direct access.

- [ ] **Step 5: Commit**

```bash
git add api/src/billing/
git commit -m "add stripe billing handlers: checkout, portal, webhook"
```

---

## Task 10: Wire Everything into main.rs

Update the Axum server to include auth routes, billing routes, middleware, and proper CORS.

**Files:**

- Modify: `api/src/main.rs`

- [ ] **Step 1: Rewrite main.rs**

Replace the entire contents of `api/src/main.rs` with:

```rust
mod db;
mod models;
mod schema;
mod auth;
mod billing;

use async_graphql::http::{playground_source, GraphQLPlaygroundConfig};
use async_graphql_axum::{GraphQLRequest, GraphQLResponse};
use axum::{
    extract::State,
    http::{header, Method, StatusCode},
    middleware as axum_middleware,
    response::{Html, IntoResponse},
    routing::{get, post},
    Router,
};
use tower_http::cors::CorsLayer;

use schema::AppSchema;

async fn graphql_handler(
    State(schema): State<AppSchema>,
    req: GraphQLRequest,
) -> GraphQLResponse {
    schema.execute(req.into_inner()).await.into()
}

async fn graphql_playground() -> impl IntoResponse {
    Html(playground_source(GraphQLPlaygroundConfig::new("/graphql")))
}

async fn health() -> impl IntoResponse {
    (StatusCode::OK, "ok")
}

#[tokio::main]
async fn main() {
    dotenvy::from_filename(".env.local").ok();
    dotenvy::dotenv().ok();

    tracing_subscriber::fmt()
        .with_env_filter("irish_rail_api=info")
        .init();

    let pool = db::create_pool().await;
    tracing::info!("connected to database");

    let gql_schema = schema::build_schema(pool.clone());

    let allowed_origins = std::env::var("CORS_ORIGINS")
        .unwrap_or_else(|_| "http://localhost:3000,http://localhost:5173".to_string());

    let origins: Vec<_> = allowed_origins
        .split(',')
        .filter_map(|s| s.trim().parse().ok())
        .collect();

    let cors = CorsLayer::new()
        .allow_origin(origins)
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION, header::COOKIE])
        .allow_credentials(true);

    // auth routes -- no per-group middleware, global middleware handles JWT extraction
    let auth_routes = Router::new()
        .route("/register", post(auth::handlers::register))
        .route("/login", post(auth::handlers::login))
        .route("/refresh", post(auth::handlers::refresh))
        .route("/logout", post(auth::handlers::logout))
        .route("/me", get(auth::handlers::me))
        .with_state(pool.clone());

    // billing routes (user comes from global auth middleware)
    let billing_routes = Router::new()
        .route("/checkout", post(billing::handlers::checkout))
        .route("/portal", post(billing::handlers::portal))
        .with_state(pool.clone());

    // webhook is separate -- uses stripe signature, not cookies
    let webhook_route = Router::new()
        .route("/billing/webhook", post(billing::handlers::webhook))
        .with_state(pool.clone());

    // global auth middleware runs once on every request, extracts
    // Option<AuthUser> from cookies. does NOT reject unauthenticated requests.
    let app = Router::new()
        .route("/graphql", get(graphql_playground).post(graphql_handler))
        .with_state(gql_schema)
        .nest("/auth", auth_routes)
        .nest("/billing", billing_routes)
        .merge(webhook_route)
        .route("/health", get(health))
        .layer(axum_middleware::from_fn(auth::middleware::auth_middleware))
        .layer(cors);

    let addr = "0.0.0.0:8000";
    tracing::info!("listening on {}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
```

- [ ] **Step 2: Inject AuthUser into GraphQL context**

Update `api/src/schema/mod.rs` to pass the `AuthUser` from request extensions into the GraphQL context. Replace its contents:

```rust
pub mod types;
pub mod station;
pub mod train;
pub mod analytics;

use async_graphql::{MergedObject, Schema, EmptyMutation, EmptySubscription};
use sqlx::PgPool;

use station::StationQuery;
use train::TrainQuery;
use analytics::AnalyticsQuery;

#[derive(MergedObject, Default)]
pub struct Query(StationQuery, TrainQuery, AnalyticsQuery);

pub type AppSchema = Schema<Query, EmptyMutation, EmptySubscription>;

pub fn build_schema(pool: PgPool) -> AppSchema {
    Schema::build(Query::default(), EmptyMutation, EmptySubscription)
        .data(pool)
        .finish()
}
```

Note: The GraphQL schema doesn't change. The `AuthUser` is available via request extensions in the Axum layer. To use it in resolvers, we'd need to add a custom GraphQL guard or pass it through the context -- that's a future task when specific resolvers need to check authorization.

- [ ] **Step 3: Build the project**

Run: `cargo build` (from `api/` directory)

Expected: Successful build. Fix any compilation errors. Common issues:

- Axum state type mismatches (some routes use `PgPool`, the graphql route uses `AppSchema`)
- Cookie crate version mismatches with axum-extra
- Stripe types may not match exactly -- adjust as needed

- [ ] **Step 4: Commit**

```bash
git add api/src/main.rs api/src/schema/mod.rs
git commit -m "wire auth and billing routes into axum server"
```

---

## Task 11: Update Docker Compose

**Files:**

- Modify: `docker-compose.yml`

- [ ] **Step 1: Add environment variables to the api service**

In `docker-compose.yml`, find the `api` service and add these environment variables alongside the existing `DATABASE_URL`:

```yaml
environment:
  DATABASE_URL: postgresql://irish_data:secure_password@db:5432/ireland_public
  JWT_SECRET: ${JWT_SECRET:-change-me-to-a-real-secret-in-production}
  JWT_ACCESS_EXPIRY: "900"
  JWT_REFRESH_EXPIRY: "604800"
  COOKIE_SECURE: "false"
  CORS_ORIGINS: "http://localhost:3000"
  APP_URL: "http://localhost:3000"
  STRIPE_SECRET_KEY: ${STRIPE_SECRET_KEY:-}
  STRIPE_WEBHOOK_SECRET: ${STRIPE_WEBHOOK_SECRET:-}
  STRIPE_COFFEE_PRICE_ID: ${STRIPE_COFFEE_PRICE_ID:-}
  STRIPE_PRO_PRICE_ID: ${STRIPE_PRO_PRICE_ID:-}
```

- [ ] **Step 2: Update nginx.conf to proxy auth and billing routes**

Add to `dashboard/nginx.conf` before the `location /` block:

```nginx
    location /auth {
        proxy_pass http://api:8000/auth;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location /billing {
        proxy_pass http://api:8000/billing;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
```

- [ ] **Step 3: Update vite proxy for dev**

Add auth and billing proxies to `dashboard/vite.config.ts`:

```typescript
import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/graphql": "http://localhost:8000",
      "/auth": "http://localhost:8000",
      "/billing": "http://localhost:8000",
    },
  },
});
```

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml dashboard/nginx.conf dashboard/vite.config.ts
git commit -m "add auth and billing proxy config for dev and prod"
```

---

## Task 12: React API Client

Create a typed fetch wrapper for auth and billing REST endpoints.

**Files:**

- Create: `dashboard/src/graphql/api.ts`
- Modify: `dashboard/src/graphql/client.ts`

- [ ] **Step 1: Create the REST API wrapper**

Create `dashboard/src/graphql/api.ts`:

```typescript
// typed fetch wrapper for auth + billing REST endpoints
// all requests include credentials so cookies are sent automatically

export interface User {
  id: string;
  email: string;
  display_name: string | null;
  role: string;
}

export interface MeUser extends User {
  stripe_customer_id: string | null;
  created_at: string;
}

interface ErrorBody {
  error: string;
}

class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...options,
  });

  if (!res.ok) {
    const body: ErrorBody = await res
      .json()
      .catch(() => ({ error: "unknown error" }));
    throw new ApiError(res.status, body.error);
  }

  // some endpoints (logout) may return empty body
  const text = await res.text();
  return text ? JSON.parse(text) : ({} as T);
}

export const api = {
  register(email: string, password: string, displayName?: string) {
    return request<User>("/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, password, display_name: displayName }),
    });
  },

  login(email: string, password: string) {
    return request<User>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
  },

  logout() {
    return request<Record<string, never>>("/auth/logout", { method: "POST" });
  },

  refresh() {
    return request<User>("/auth/refresh", { method: "POST" });
  },

  me() {
    return request<MeUser>("/auth/me");
  },

  checkout(priceId: string) {
    return request<{ url: string }>("/billing/checkout", {
      method: "POST",
      body: JSON.stringify({ price_id: priceId }),
    });
  },

  portal() {
    return request<{ url: string }>("/billing/portal", { method: "POST" });
  },
};

export { ApiError };
```

- [ ] **Step 2: Update URQL client to send cookies**

Replace `dashboard/src/graphql/client.ts`:

```typescript
import { Client, cacheExchange, fetchExchange } from "urql";

const url = import.meta.env.VITE_GRAPHQL_URL || "/graphql";

export const client = new Client({
  url,
  exchanges: [cacheExchange, fetchExchange],
  fetchOptions: {
    credentials: "include",
  },
});
```

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/graphql/api.ts dashboard/src/graphql/client.ts
git commit -m "add REST api client and enable cookie credentials on URQL"
```

---

## Task 13: React AuthProvider and useAuth Hook

**Files:**

- Create: `dashboard/src/auth/AuthProvider.tsx`
- Create: `dashboard/src/auth/useAuth.ts`

- [ ] **Step 1: Create AuthProvider**

Create `dashboard/src/auth/AuthProvider.tsx`:

```tsx
import {
  createContext,
  useCallback,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { api, type User, type MeUser, ApiError } from "../graphql/api";

export interface AuthContextValue {
  user: MeUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (
    email: string,
    password: string,
    displayName?: string,
  ) => Promise<void>;
  logout: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<MeUser | null>(null);
  const [loading, setLoading] = useState(true);

  // check if user is logged in on mount
  useEffect(() => {
    api
      .me()
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  // auto-refresh: if /me fails with 401, try refreshing the token
  const fetchUser = useCallback(async () => {
    try {
      const u = await api.me();
      setUser(u);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        try {
          await api.refresh();
          const u = await api.me();
          setUser(u);
        } catch {
          setUser(null);
        }
      }
    }
  }, []);

  const login = useCallback(
    async (email: string, password: string) => {
      await api.login(email, password);
      await fetchUser();
    },
    [fetchUser],
  );

  const register = useCallback(
    async (email: string, password: string, displayName?: string) => {
      await api.register(email, password, displayName);
      await fetchUser();
    },
    [fetchUser],
  );

  const logout = useCallback(async () => {
    await api.logout();
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}
```

- [ ] **Step 2: Create useAuth hook**

Create `dashboard/src/auth/useAuth.ts`:

```typescript
import { useContext } from "react";
import { AuthContext, type AuthContextValue } from "./AuthProvider";

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return ctx;
}
```

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/auth/
git commit -m "add AuthProvider context and useAuth hook"
```

---

## Task 14: Login and Register Pages

**Files:**

- Create: `dashboard/src/auth/LoginPage.tsx`
- Create: `dashboard/src/auth/RegisterPage.tsx`
- Create: `dashboard/src/auth/ProtectedRoute.tsx`

- [ ] **Step 1: Create LoginPage**

Create `dashboard/src/auth/LoginPage.tsx`:

```tsx
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "./useAuth";
import { ApiError } from "../graphql/api";

export default function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      await login(email, password);
      navigate("/");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "login failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex items-center justify-center min-h-[calc(100vh-60px)]">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm space-y-4 p-6 bg-[var(--rail-surface)] rounded-lg border border-[var(--rail-border)]"
      >
        <h2 className="text-xl font-bold text-white">Log in</h2>

        {error && <p className="text-sm text-[var(--rail-red)]">{error}</p>}

        <div className="space-y-1">
          <label className="block text-sm text-[var(--rail-muted)]">
            Email
          </label>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded bg-[var(--rail-bg)] border border-[var(--rail-border)] px-3 py-2 text-white focus:outline-none focus:border-[var(--rail-green)]"
          />
        </div>

        <div className="space-y-1">
          <label className="block text-sm text-[var(--rail-muted)]">
            Password
          </label>
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded bg-[var(--rail-bg)] border border-[var(--rail-border)] px-3 py-2 text-white focus:outline-none focus:border-[var(--rail-green)]"
          />
        </div>

        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded bg-[var(--rail-green)] py-2 text-sm font-medium text-black transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {submitting ? "Logging in..." : "Log in"}
        </button>

        <p className="text-sm text-[var(--rail-muted)] text-center">
          Don't have an account?{" "}
          <Link
            to="/register"
            className="text-[var(--rail-green)] hover:underline"
          >
            Sign up
          </Link>
        </p>
      </form>
    </div>
  );
}
```

- [ ] **Step 2: Create RegisterPage**

Create `dashboard/src/auth/RegisterPage.tsx`:

```tsx
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "./useAuth";
import { ApiError } from "../graphql/api";

export default function RegisterPage() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      await register(email, password, displayName || undefined);
      navigate("/");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "registration failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex items-center justify-center min-h-[calc(100vh-60px)]">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm space-y-4 p-6 bg-[var(--rail-surface)] rounded-lg border border-[var(--rail-border)]"
      >
        <h2 className="text-xl font-bold text-white">Create account</h2>

        {error && <p className="text-sm text-[var(--rail-red)]">{error}</p>}

        <div className="space-y-1">
          <label className="block text-sm text-[var(--rail-muted)]">
            Display name
          </label>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className="w-full rounded bg-[var(--rail-bg)] border border-[var(--rail-border)] px-3 py-2 text-white focus:outline-none focus:border-[var(--rail-green)]"
            placeholder="optional"
          />
        </div>

        <div className="space-y-1">
          <label className="block text-sm text-[var(--rail-muted)]">
            Email
          </label>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded bg-[var(--rail-bg)] border border-[var(--rail-border)] px-3 py-2 text-white focus:outline-none focus:border-[var(--rail-green)]"
          />
        </div>

        <div className="space-y-1">
          <label className="block text-sm text-[var(--rail-muted)]">
            Password
          </label>
          <input
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded bg-[var(--rail-bg)] border border-[var(--rail-border)] px-3 py-2 text-white focus:outline-none focus:border-[var(--rail-green)]"
            placeholder="min 8 characters"
          />
        </div>

        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded bg-[var(--rail-green)] py-2 text-sm font-medium text-black transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {submitting ? "Creating account..." : "Create account"}
        </button>

        <p className="text-sm text-[var(--rail-muted)] text-center">
          Already have an account?{" "}
          <Link
            to="/login"
            className="text-[var(--rail-green)] hover:underline"
          >
            Log in
          </Link>
        </p>
      </form>
    </div>
  );
}
```

- [ ] **Step 3: Create ProtectedRoute**

Create `dashboard/src/auth/ProtectedRoute.tsx`:

```tsx
import { Navigate } from "react-router-dom";
import { useAuth } from "./useAuth";

export default function ProtectedRoute({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-[var(--rail-muted)]">Loading...</p>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}
```

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/auth/LoginPage.tsx dashboard/src/auth/RegisterPage.tsx dashboard/src/auth/ProtectedRoute.tsx
git commit -m "add login, register, and protected route components"
```

---

## Task 15: Pricing and Account Pages

**Files:**

- Create: `dashboard/src/billing/PricingPage.tsx`
- Create: `dashboard/src/billing/AccountPage.tsx`

- [ ] **Step 1: Create PricingPage**

Create `dashboard/src/billing/PricingPage.tsx`:

```tsx
import { useState } from "react";
import { useAuth } from "../auth/useAuth";
import { api, ApiError } from "../graphql/api";
import { useNavigate } from "react-router-dom";

const plans = [
  {
    name: "Free",
    price: "€0",
    period: "",
    features: ["Live train map", "Station list", "1,000 requests/day"],
    priceId: null,
    current: "free",
  },
  {
    name: "Coffee Club",
    price: "€25",
    period: "/mo",
    features: [
      "Everything in Free",
      "Analytics dashboard",
      "Historical data",
      "10,000 requests/day",
    ],
    priceId: import.meta.env.VITE_STRIPE_COFFEE_PRICE_ID || "",
    current: "coffee",
  },
  {
    name: "Pro",
    price: "€75",
    period: "/mo",
    features: [
      "Everything in Coffee Club",
      "Unlimited requests",
      "Raw data export",
      "Priority support",
    ],
    priceId: import.meta.env.VITE_STRIPE_PRO_PRICE_ID || "",
    current: "pro",
    highlight: true,
  },
];

export default function PricingPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function handleCheckout(priceId: string) {
    if (!user) {
      navigate("/register");
      return;
    }
    setLoading(priceId);
    setError("");
    try {
      const { url } = await api.checkout(priceId);
      window.location.href = url;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "checkout failed");
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="mx-auto max-w-4xl px-6 py-12">
      <h1 className="text-2xl font-bold text-white text-center mb-2">
        Pricing
      </h1>
      <p className="text-[var(--rail-muted)] text-center mb-8">
        Real-time Irish Rail data for developers and analysts
      </p>

      {error && (
        <p className="text-center text-sm text-[var(--rail-red)] mb-4">
          {error}
        </p>
      )}

      <div className="grid gap-6 md:grid-cols-3">
        {plans.map((plan) => {
          const isCurrent = user?.role === plan.current;
          return (
            <div
              key={plan.name}
              className={`rounded-lg border p-6 ${
                plan.highlight
                  ? "border-[var(--rail-green)] bg-[var(--rail-surface)]"
                  : "border-[var(--rail-border)] bg-[var(--rail-surface)]"
              }`}
            >
              <h3 className="text-lg font-semibold text-white">{plan.name}</h3>
              <p className="mt-2 text-3xl font-bold text-white">
                {plan.price}
                <span className="text-sm font-normal text-[var(--rail-muted)]">
                  {plan.period}
                </span>
              </p>
              <ul className="mt-4 space-y-2">
                {plan.features.map((f) => (
                  <li
                    key={f}
                    className="flex items-start gap-2 text-sm text-[var(--rail-muted)]"
                  >
                    <span className="text-[var(--rail-green)]">+</span>
                    {f}
                  </li>
                ))}
              </ul>
              <div className="mt-6">
                {isCurrent ? (
                  <span className="block text-center text-sm text-[var(--rail-green)] font-medium">
                    Current plan
                  </span>
                ) : plan.priceId ? (
                  <button
                    onClick={() => handleCheckout(plan.priceId!)}
                    disabled={loading !== null}
                    className="w-full rounded bg-[var(--rail-green)] py-2 text-sm font-medium text-black transition-opacity hover:opacity-90 disabled:opacity-50"
                  >
                    {loading === plan.priceId ? "Redirecting..." : "Subscribe"}
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create AccountPage**

Create `dashboard/src/billing/AccountPage.tsx`:

```tsx
import { useState } from "react";
import { useAuth } from "../auth/useAuth";
import { api, ApiError } from "../graphql/api";

const roleLabels: Record<string, string> = {
  free: "Free",
  coffee: "Coffee Club",
  pro: "Pro",
  admin: "Admin",
};

export default function AccountPage() {
  const { user, logout } = useAuth();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  if (!user) return null;

  async function openPortal() {
    setLoading(true);
    setError("");
    try {
      const { url } = await api.portal();
      window.location.href = url;
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "failed to open billing portal",
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-lg px-6 py-12">
      <h1 className="text-2xl font-bold text-white mb-6">Account</h1>

      {error && <p className="text-sm text-[var(--rail-red)] mb-4">{error}</p>}

      <div className="space-y-4 rounded-lg border border-[var(--rail-border)] bg-[var(--rail-surface)] p-6">
        <div>
          <p className="text-sm text-[var(--rail-muted)]">Email</p>
          <p className="text-white">{user.email}</p>
        </div>
        {user.display_name && (
          <div>
            <p className="text-sm text-[var(--rail-muted)]">Display name</p>
            <p className="text-white">{user.display_name}</p>
          </div>
        )}
        <div>
          <p className="text-sm text-[var(--rail-muted)]">Plan</p>
          <p className="text-white">{roleLabels[user.role] || user.role}</p>
        </div>
        <div>
          <p className="text-sm text-[var(--rail-muted)]">Member since</p>
          <p className="text-white">
            {new Date(user.created_at).toLocaleDateString()}
          </p>
        </div>

        <div className="flex gap-3 pt-2">
          {user.stripe_customer_id && (
            <button
              onClick={openPortal}
              disabled={loading}
              className="rounded border border-[var(--rail-border)] px-4 py-2 text-sm text-white transition-colors hover:bg-[var(--rail-bg)] disabled:opacity-50"
            >
              {loading ? "Opening..." : "Manage subscription"}
            </button>
          )}
          <button
            onClick={logout}
            className="rounded border border-[var(--rail-red)] px-4 py-2 text-sm text-[var(--rail-red)] transition-colors hover:bg-[var(--rail-red)] hover:text-white"
          >
            Log out
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/billing/
git commit -m "add pricing and account pages with stripe checkout"
```

---

## Task 16: Update Layout and App Routes

Wire everything together in the React app.

**Files:**

- Modify: `dashboard/src/components/Layout.tsx`
- Modify: `dashboard/src/App.tsx`

- [ ] **Step 1: Update Layout with auth buttons**

Replace `dashboard/src/components/Layout.tsx`:

```tsx
import { NavLink, Outlet, Link } from "react-router-dom";
import { useAuth } from "../auth/useAuth";

const links = [
  { to: "/", label: "Live Map" },
  { to: "/stations", label: "Stations" },
  { to: "/analytics", label: "Analytics" },
  { to: "/pricing", label: "Pricing" },
];

export default function Layout() {
  const { user, loading } = useAuth();

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-6 border-b border-[var(--rail-border)] bg-[var(--rail-surface)] px-6 py-3">
        <h1 className="text-lg font-bold tracking-tight text-white">
          Irish Rail
        </h1>
        <nav className="flex gap-4">
          {links.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              className={({ isActive }) =>
                `text-sm transition-colors ${
                  isActive
                    ? "text-[var(--rail-green)] font-medium"
                    : "text-[var(--rail-muted)] hover:text-white"
                }`
              }
            >
              {l.label}
            </NavLink>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-3">
          {loading ? null : user ? (
            <Link
              to="/account"
              className="text-sm text-[var(--rail-muted)] hover:text-white transition-colors"
            >
              {user.display_name || user.email}
            </Link>
          ) : (
            <>
              <Link
                to="/login"
                className="text-sm text-[var(--rail-muted)] hover:text-white transition-colors"
              >
                Log in
              </Link>
              <Link
                to="/register"
                className="rounded bg-[var(--rail-green)] px-3 py-1.5 text-sm font-medium text-black transition-opacity hover:opacity-90"
              >
                Sign up
              </Link>
            </>
          )}
        </div>
      </header>
      <main className="min-h-0 flex-1">
        <Outlet />
      </main>
    </div>
  );
}
```

- [ ] **Step 2: Update App.tsx with AuthProvider and new routes**

Replace `dashboard/src/App.tsx`:

```tsx
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Provider } from "urql";
import { client } from "./graphql/client";
import { AuthProvider } from "./auth/AuthProvider";
import Layout from "./components/Layout";
import LiveMap from "./pages/LiveMap";
import Stations from "./pages/Stations";
import Analytics from "./pages/Analytics";
import LoginPage from "./auth/LoginPage";
import RegisterPage from "./auth/RegisterPage";
import ProtectedRoute from "./auth/ProtectedRoute";
import PricingPage from "./billing/PricingPage";
import AccountPage from "./billing/AccountPage";

export default function App() {
  return (
    <Provider value={client}>
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            <Route element={<Layout />}>
              <Route index element={<LiveMap />} />
              <Route path="stations" element={<Stations />} />
              <Route path="login" element={<LoginPage />} />
              <Route path="register" element={<RegisterPage />} />
              <Route path="pricing" element={<PricingPage />} />
              <Route
                path="analytics"
                element={
                  <ProtectedRoute>
                    <Analytics />
                  </ProtectedRoute>
                }
              />
              <Route
                path="account"
                element={
                  <ProtectedRoute>
                    <AccountPage />
                  </ProtectedRoute>
                }
              />
            </Route>
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </Provider>
  );
}
```

- [ ] **Step 3: Verify the frontend builds**

Run: `pnpm build` (from `dashboard/` directory)

Expected: Builds without errors.

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/components/Layout.tsx dashboard/src/App.tsx
git commit -m "wire auth and billing into app layout and routing"
```

---

## Task 17: Manual End-to-End Verification

Verify the full auth flow works.

- [ ] **Step 1: Set up environment**

Create/update `.env.local` in `api/` directory:

```bash
DATABASE_URL=postgres://irish_data:secure_password@localhost:9898/ireland_public
JWT_SECRET=dev-secret-change-in-production-must-be-long-enough-64chars!!
JWT_ACCESS_EXPIRY=900
JWT_REFRESH_EXPIRY=604800
COOKIE_SECURE=false
CORS_ORIGINS=http://localhost:5173,http://localhost:3000
APP_URL=http://localhost:3000
```

- [ ] **Step 2: Run the database migration**

```bash
docker exec -i irish-rail-nabber-db-1 psql -U irish_data -d ireland_public < migrations/004_add_users_and_auth.sql
```

- [ ] **Step 3: Build and run the API**

Run: `cargo run` (from `api/` directory)

Expected: Server starts on port 8000.

- [ ] **Step 4: Test registration via curl**

```bash
curl -v -X POST http://localhost:8000/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"test@example.com","password":"testpassword123"}'
```

Expected: 201 response with user JSON, `Set-Cookie` headers for `access_token` and `refresh_token`.

- [ ] **Step 5: Test login via curl**

```bash
curl -v -X POST http://localhost:8000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"test@example.com","password":"testpassword123"}'
```

Expected: 200 response with user JSON and cookie headers.

- [ ] **Step 6: Test /auth/me with the access token cookie**

```bash
# use the access_token cookie value from the login response
curl -v http://localhost:8000/auth/me \
  -H 'Cookie: access_token=<token-from-step-5>'
```

Expected: 200 response with user profile.

- [ ] **Step 7: Run the React dashboard**

Run: `pnpm dev` (from `dashboard/` directory)

Open http://localhost:5173 in the browser. Verify:

- Login/Register links appear in the header
- Clicking "Sign up" shows the register form
- Registration creates account and redirects to home
- User name appears in header
- Account page shows user info
- Logout clears the session

- [ ] **Step 8: Commit any fixes**

If any adjustments were needed during testing, commit them:

```bash
git add -A
git commit -m "fix issues found during end-to-end testing"
```
