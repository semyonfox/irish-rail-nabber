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
    errors::ErrorKind,
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum VerificationStage {
    Configuration,
    Header,
    Jwks,
    DecodingKey,
    Claims,
    AuthorizedParty,
}

impl VerificationStage {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Configuration => "configuration",
            Self::Header => "header",
            Self::Jwks => "jwks",
            Self::DecodingKey => "decoding_key",
            Self::Claims => "claims",
            Self::AuthorizedParty => "authorized_party",
        }
    }
}

// Keep verifier failures safe to log. In particular, never retain the token,
// claim values, key ID, or errors whose messages may include input data.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct VerificationError {
    stage: VerificationStage,
    kind: &'static str,
}

impl VerificationError {
    const fn new(stage: VerificationStage, kind: &'static str) -> Self {
        Self { stage, kind }
    }

    pub(crate) const fn stage(self) -> &'static str {
        self.stage.as_str()
    }

    pub(crate) const fn kind(self) -> &'static str {
        self.kind
    }

    #[cfg(test)]
    pub(crate) const fn rejected_token_for_test() -> Self {
        Self::new(VerificationStage::Claims, "invalid_signature")
    }
}

fn jwt_error_kind(error: &jsonwebtoken::errors::Error) -> &'static str {
    match error.kind() {
        ErrorKind::InvalidToken => "invalid_token",
        ErrorKind::InvalidSignature => "invalid_signature",
        ErrorKind::InvalidEcdsaKey => "invalid_ecdsa_key",
        ErrorKind::InvalidEddsaKey => "invalid_eddsa_key",
        ErrorKind::InvalidRsaKey(_) => "invalid_rsa_key",
        ErrorKind::RsaFailedSigning => "rsa_signing_failed",
        ErrorKind::Signing(_) => "signing_failed",
        ErrorKind::InvalidAlgorithmName => "invalid_algorithm_name",
        ErrorKind::InvalidKeyFormat => "invalid_key_format",
        ErrorKind::MissingRequiredClaim(_) => "missing_required_claim",
        ErrorKind::InvalidClaimFormat(_) => "invalid_claim_format",
        ErrorKind::ExpiredSignature => "expired",
        ErrorKind::InvalidIssuer => "invalid_issuer",
        ErrorKind::InvalidAudience => "invalid_audience",
        ErrorKind::InvalidSubject => "invalid_subject",
        ErrorKind::ImmatureSignature => "not_yet_valid",
        ErrorKind::InvalidAlgorithm => "invalid_algorithm",
        ErrorKind::MissingAlgorithm => "missing_algorithm",
        ErrorKind::Base64(_) => "invalid_base64",
        ErrorKind::Json(_) => "invalid_json",
        ErrorKind::Utf8(_) => "invalid_utf8",
        ErrorKind::Provider(_) => "crypto_provider",
        _ => "unknown",
    }
}

fn jwks_error_kind(error: &reqwest::Error) -> &'static str {
    if error.is_timeout() {
        "timeout"
    } else if error.is_status() {
        "http_status"
    } else if error.is_decode() {
        "invalid_response"
    } else if error.is_connect() {
        "connection"
    } else {
        "request"
    }
}

fn validate_authorized_party(
    claims: &SessionClaims,
    authorized_parties: &[String],
) -> Result<(), VerificationError> {
    if authorized_parties.is_empty() {
        return Ok(());
    }

    let azp = claims
        .azp
        .as_deref()
        .map(|value| value.trim_end_matches('/'))
        .ok_or_else(|| VerificationError::new(VerificationStage::AuthorizedParty, "missing"))?;
    if authorized_parties.iter().any(|party| party == azp) {
        Ok(())
    } else {
        Err(VerificationError::new(
            VerificationStage::AuthorizedParty,
            "not_allowed",
        ))
    }
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
async fn signing_key(cfg: &ClerkConfig, kid: &str) -> Result<Jwk, VerificationError> {
    static JWKS: OnceLock<RwLock<Option<CachedJwks>>> = OnceLock::new();
    let lock = JWKS.get_or_init(|| RwLock::new(None));

    {
        let guard = lock.read().await;
        if let Some(cached) = guard.as_ref() {
            match cached.set.find(kid) {
                Some(jwk) if cached.fetched.elapsed() < JWKS_TTL => return Ok(jwk.clone()),
                None if cached.fetched.elapsed() < JWKS_MIN_REFRESH => {
                    return Err(VerificationError::new(
                        VerificationStage::Jwks,
                        "key_not_found",
                    ));
                }
                _ => {}
            }
        }
    }

    let mut guard = lock.write().await;
    if let Some(cached) = guard.as_ref() {
        if cached.fetched.elapsed() < JWKS_MIN_REFRESH {
            return cached
                .set
                .find(kid)
                .cloned()
                .ok_or_else(|| VerificationError::new(VerificationStage::Jwks, "key_not_found"));
        }
    }
    match fetch_jwks(cfg).await {
        Ok(set) => {
            let jwk = set.find(kid).cloned();
            *guard = Some(CachedJwks {
                set,
                fetched: Instant::now(),
            });
            jwk.ok_or_else(|| VerificationError::new(VerificationStage::Jwks, "key_not_found"))
        }
        Err(error) => {
            let failure = VerificationError::new(VerificationStage::Jwks, jwks_error_kind(&error));
            if let Some(jwk) = guard
                .as_ref()
                .and_then(|cached| cached.set.find(kid).cloned())
            {
                tracing::warn!(
                    stage = failure.stage(),
                    kind = failure.kind(),
                    "clerk jwks refresh failed, using cached signing key"
                );
                Ok(jwk)
            } else {
                Err(failure)
            }
        }
    }
}

pub async fn verify_session_token(token: &str) -> Result<SessionClaims, VerificationError> {
    let cfg = config().ok_or_else(|| {
        VerificationError::new(VerificationStage::Configuration, "not_configured")
    })?;
    let header = decode_header(token).map_err(|error| {
        VerificationError::new(VerificationStage::Header, jwt_error_kind(&error))
    })?;
    if header.alg != Algorithm::RS256 {
        return Err(VerificationError::new(
            VerificationStage::Header,
            "unexpected_algorithm",
        ));
    }
    let kid = header
        .kid
        .as_deref()
        .ok_or_else(|| VerificationError::new(VerificationStage::Header, "missing_key_id"))?;
    let jwk = signing_key(cfg, kid).await?;
    let key = DecodingKey::from_jwk(&jwk).map_err(|error| {
        VerificationError::new(VerificationStage::DecodingKey, jwt_error_kind(&error))
    })?;

    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_issuer(&[cfg.issuer.as_str()]);
    validation.validate_aud = false;
    validation.validate_nbf = true;
    validation.leeway = 5;

    let claims = decode::<SessionClaims>(token, &key, &validation)
        .map_err(|error| VerificationError::new(VerificationStage::Claims, jwt_error_kind(&error)))?
        .claims;

    // Clerk sets azp to the origin that minted the token. Once an allowlist is
    // configured, a missing azp is no safer than a mismatched one.
    validate_authorized_party(&claims, &cfg.authorized_parties)?;

    Ok(claims)
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

#[cfg(test)]
mod tests {
    use jsonwebtoken::errors::new_error;

    use super::*;

    #[test]
    fn jwt_error_labels_discard_dynamic_details() {
        let jwt_error = new_error(ErrorKind::MissingRequiredClaim(
            "value-that-must-not-reach-logs".to_string(),
        ));
        let error = VerificationError::new(VerificationStage::Claims, jwt_error_kind(&jwt_error));

        assert_eq!(error.stage(), "claims");
        assert_eq!(error.kind(), "missing_required_claim");
        assert!(!format!("{error:?}").contains("value-that-must-not-reach-logs"));
    }

    #[test]
    fn accepts_clerks_numeric_original_issued_at_header() {
        let encoded_header = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(
            br#"{"alg":"RS256","cat":"session_token","kid":"test-key","oiat":1700000000,"typ":"JWT"}"#,
        );
        let token = format!("{encoded_header}.e30.signature");

        let header = decode_header(token).expect("Clerk header should parse");

        assert_eq!(header.alg, Algorithm::RS256);
        assert_eq!(header.kid.as_deref(), Some("test-key"));
        assert_eq!(
            header.extras.get::<u64>("oiat").expect("numeric oiat"),
            Some(1_700_000_000)
        );
    }

    #[test]
    fn authorized_party_failures_have_stable_labels() {
        let allowed = vec!["https://traein.example".to_string()];
        let missing = SessionClaims {
            sub: "ignored-in-this-check".to_string(),
            azp: None,
        };
        let mismatch = SessionClaims {
            sub: "ignored-in-this-check".to_string(),
            azp: Some("https://other.example".to_string()),
        };

        assert_eq!(
            validate_authorized_party(&missing, &allowed),
            Err(VerificationError::new(
                VerificationStage::AuthorizedParty,
                "missing"
            ))
        );
        assert_eq!(
            validate_authorized_party(&mismatch, &allowed),
            Err(VerificationError::new(
                VerificationStage::AuthorizedParty,
                "not_allowed"
            ))
        );
    }

    #[test]
    fn authorized_party_normalizes_a_trailing_slash() {
        let allowed = vec!["https://traein.example".to_string()];
        let claims = SessionClaims {
            sub: "ignored-in-this-check".to_string(),
            azp: Some("https://traein.example/".to_string()),
        };

        assert_eq!(validate_authorized_party(&claims, &allowed), Ok(()));
    }
}
