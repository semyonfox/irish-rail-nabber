// clerk session verification. clerk issues short-lived RS256 session jwts signed
// by the instance's jwks; we verify them locally and map the clerk user onto our
// own users row so Polar can manage plan roles independently of identity
use std::{
    sync::OnceLock,
    time::{Duration, Instant},
};

use base64::{
    alphabet,
    engine::{general_purpose::GeneralPurpose, DecodePaddingMode, GeneralPurposeConfig},
    Engine,
};
use jsonwebtoken::{
    decode, decode_header,
    jwk::{Jwk, JwkSet},
    Algorithm, DecodingKey, Validation,
};
use moka::future::Cache;
use serde::Deserialize;
use sqlx::PgPool;
use tokio::sync::RwLock;

use crate::{db::users, models::AuthUser};

const JWKS_TTL: Duration = Duration::from_secs(3600);
const JWKS_MIN_REFRESH: Duration = Duration::from_secs(60);
const USER_CACHE_TTL: Duration = Duration::from_secs(60);

struct ClerkConfig {
    issuer: String,
    jwks_url: String,
    secret_key: Option<String>,
    authorized_parties: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct SessionClaims {
    pub sub: String,
    #[serde(default)]
    pub azp: Option<String>,
}

struct CachedJwks {
    set: JwkSet,
    fetched: Instant,
}

// pk_test_<base64("clerk.example.com$")> -> clerk.example.com
fn frontend_api_host(publishable_key: &str) -> Option<String> {
    let encoded = publishable_key
        .strip_prefix("pk_test_")
        .or_else(|| publishable_key.strip_prefix("pk_live_"))?;
    let engine = GeneralPurpose::new(
        &alphabet::STANDARD,
        GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent),
    );
    let decoded = String::from_utf8(engine.decode(encoded).ok()?).ok()?;
    let host = decoded.trim_end_matches('$');
    (!host.is_empty()).then(|| host.to_string())
}

fn config() -> Option<&'static ClerkConfig> {
    static CONFIG: OnceLock<Option<ClerkConfig>> = OnceLock::new();
    CONFIG
        .get_or_init(|| {
            let env = |name: &str| std::env::var(name).ok().filter(|v| !v.trim().is_empty());
            let issuer = env("CLERK_ISSUER").or_else(|| {
                env("CLERK_PUBLISHABLE_KEY")
                    .as_deref()
                    .and_then(frontend_api_host)
                    .map(|host| format!("https://{host}"))
            });
            let Some(issuer) = issuer else {
                tracing::warn!("clerk is not configured, every request is anonymous");
                return None;
            };
            let jwks_url =
                env("CLERK_JWKS_URL").unwrap_or_else(|| format!("{issuer}/.well-known/jwks.json"));
            let authorized_parties = env("CLERK_AUTHORIZED_PARTIES")
                .or_else(|| env("CORS_ORIGINS"))
                .unwrap_or_default()
                .split(',')
                .map(|value| value.trim().trim_end_matches('/').to_string())
                .filter(|value| !value.is_empty())
                .collect();
            Some(ClerkConfig {
                issuer,
                jwks_url,
                secret_key: env("CLERK_SECRET_KEY"),
                authorized_parties,
            })
        })
        .as_ref()
}

fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .expect("http client")
    })
}

async fn fetch_jwks(cfg: &ClerkConfig) -> Result<JwkSet, reqwest::Error> {
    http()
        .get(&cfg.jwks_url)
        .send()
        .await?
        .error_for_status()?
        .json::<JwkSet>()
        .await
}

// keys rotate rarely, so cache them and only refetch for an unknown kid,
// at most once a minute so a forged kid can't hammer clerk
async fn signing_key(cfg: &ClerkConfig, kid: &str) -> Option<Jwk> {
    static JWKS: OnceLock<RwLock<Option<CachedJwks>>> = OnceLock::new();
    let lock = JWKS.get_or_init(|| RwLock::new(None));

    {
        let guard = lock.read().await;
        if let Some(cached) = guard.as_ref() {
            match cached.set.find(kid) {
                Some(jwk) if cached.fetched.elapsed() < JWKS_TTL => return Some(jwk.clone()),
                None if cached.fetched.elapsed() < JWKS_MIN_REFRESH => return None,
                _ => {}
            }
        }
    }

    let mut guard = lock.write().await;
    if let Some(cached) = guard.as_ref() {
        if cached.fetched.elapsed() < JWKS_MIN_REFRESH {
            return cached.set.find(kid).cloned();
        }
    }
    match fetch_jwks(cfg).await {
        Ok(set) => {
            let jwk = set.find(kid).cloned();
            *guard = Some(CachedJwks {
                set,
                fetched: Instant::now(),
            });
            jwk
        }
        Err(error) => {
            tracing::warn!("clerk jwks fetch failed: {error}");
            guard
                .as_ref()
                .and_then(|cached| cached.set.find(kid).cloned())
        }
    }
}

pub async fn verify_session_token(token: &str) -> Option<SessionClaims> {
    let cfg = config()?;
    let header = decode_header(token).ok()?;
    if header.alg != Algorithm::RS256 {
        return None;
    }
    let jwk = signing_key(cfg, header.kid.as_deref()?).await?;
    let key = DecodingKey::from_jwk(&jwk).ok()?;

    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_issuer(&[cfg.issuer.as_str()]);
    validation.validate_aud = false;
    validation.validate_nbf = true;
    validation.leeway = 5;

    let claims = decode::<SessionClaims>(token, &key, &validation)
        .ok()?
        .claims;

    // Clerk sets azp to the origin that minted the token. Once an allowlist is
    // configured, a missing azp is no safer than a mismatched one.
    if !cfg.authorized_parties.is_empty() {
        let Some(azp) = claims
            .azp
            .as_deref()
            .map(|value| value.trim_end_matches('/'))
        else {
            return None;
        };
        if !cfg.authorized_parties.iter().any(|party| party == azp) {
            return None;
        }
    }

    Some(claims)
}

#[derive(Deserialize)]
struct ClerkVerification {
    status: String,
}

#[derive(Deserialize)]
struct ClerkEmail {
    id: String,
    email_address: String,
    verification: Option<ClerkVerification>,
}

#[derive(Deserialize)]
struct ClerkUser {
    primary_email_address_id: Option<String>,
    #[serde(default)]
    email_addresses: Vec<ClerkEmail>,
    first_name: Option<String>,
    last_name: Option<String>,
    username: Option<String>,
}

struct Profile {
    email: String,
    display_name: Option<String>,
}

// only called the first time we see a clerk user
async fn fetch_profile(cfg: &ClerkConfig, clerk_user_id: &str) -> Option<Profile> {
    if !clerk_user_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_')
    {
        return None;
    }
    let Some(secret) = cfg.secret_key.as_deref() else {
        tracing::warn!("CLERK_SECRET_KEY is not set, new clerk users can't be provisioned");
        return None;
    };

    let user = http()
        .get(format!("https://api.clerk.com/v1/users/{clerk_user_id}"))
        .bearer_auth(secret)
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .json::<ClerkUser>()
        .await
        .ok()?;

    // linking to an existing account by email is only safe once clerk has verified it
    let email = user
        .email_addresses
        .iter()
        .find(|email| Some(&email.id) == user.primary_email_address_id.as_ref())
        .filter(|email| {
            email
                .verification
                .as_ref()
                .is_some_and(|verification| verification.status == "verified")
        })?
        .email_address
        .clone();

    let name = [user.first_name, user.last_name]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" ");
    let display_name = if name.trim().is_empty() {
        user.username
    } else {
        Some(name)
    };

    Some(Profile {
        email,
        display_name,
    })
}

fn user_cache() -> &'static Cache<String, AuthUser> {
    static CACHE: OnceLock<Cache<String, AuthUser>> = OnceLock::new();
    CACHE.get_or_init(|| {
        Cache::builder()
            .max_capacity(10_000)
            .time_to_live(USER_CACHE_TTL)
            .build()
    })
}

pub async fn invalidate_user(clerk_user_id: &str) {
    user_cache().invalidate(clerk_user_id).await;
}

pub async fn resolve_user(pool: &PgPool, claims: &SessionClaims) -> Option<AuthUser> {
    if let Some(user) = user_cache().get(&claims.sub).await {
        return Some(user);
    }

    let clerk_user_id = &claims.sub;

    let row = match users::find_user_by_clerk_id(pool, clerk_user_id).await {
        Ok(Some(row)) => row,
        Ok(None) => {
            let profile = fetch_profile(config()?, clerk_user_id).await?;
            match users::link_or_create_clerk_user(
                pool,
                clerk_user_id,
                &profile.email,
                profile.display_name.as_deref(),
            )
            .await
            {
                Ok(row) => row,
                Err(error) => {
                    tracing::warn!("clerk user provisioning failed: {error}");
                    return None;
                }
            }
        }
        Err(error) => {
            tracing::warn!("clerk user lookup failed: {error}");
            return None;
        }
    };

    let user = AuthUser {
        id: row.id,
        email: row.email,
        role: row.role,
    };
    user_cache()
        .insert(clerk_user_id.to_string(), user.clone())
        .await;
    Some(user)
}
