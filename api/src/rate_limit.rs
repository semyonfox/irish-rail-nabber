use std::env;

use axum::{
    extract::{Request, State},
    http::{HeaderValue, Method, StatusCode},
    middleware::Next,
    response::{IntoResponse, Json, Response},
};
use axum_extra::extract::CookieJar;
use chrono::{Duration, TimeZone, Utc};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::{
    auth::tokens,
    models::AuthUser,
    db::usage as usage_store,
    state::AppState,
};

#[derive(Debug, Serialize)]
struct RateLimitPayload {
    error: String,
    used: i64,
    limit: Option<i64>,
    remaining: Option<i64>,
    reset_at: i64,
}

const FREE_TIER_LIMIT: i64 = 1_000;
const COFFEE_TIER_LIMIT: i64 = 10_000;

#[derive(Debug, Serialize)]
pub struct RateLimitPolicy {
    pub free: Option<i64>,
    pub coffee: Option<i64>,
    pub pro: Option<i64>,
    pub unlimited_roles: Vec<String>,
}

fn env_limit_value(name: &str, default_value: i64) -> i64 {
    std::env::var(name)
        .ok()
        .and_then(|raw| raw.parse::<i64>().ok())
        .filter(|value| *value >= 0)
        .unwrap_or(default_value)
}

fn unlimited_roles() -> Vec<String> {
    std::env::var("API_RATE_LIMIT_UNLIMITED_ROLES")
        .unwrap_or_else(|_| "pro,admin".to_string())
        .split(',')
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty())
        .collect()
}

pub fn plan_limit(role: &str) -> Option<i64> {
    let role = role.to_lowercase();
    let unlimited_roles = unlimited_roles();
    if unlimited_roles.contains(&role) {
        return None;
    }

    match role.as_str() {
        "coffee" => Some(env_limit_value("API_RATE_LIMIT_COFFEE_TIER_LIMIT", COFFEE_TIER_LIMIT)),
        _ => Some(env_limit_value("API_RATE_LIMIT_FREE_TIER_LIMIT", FREE_TIER_LIMIT)),
    }
}

pub fn rate_limit_policy() -> RateLimitPolicy {
    let free = env_limit_value("API_RATE_LIMIT_FREE_TIER_LIMIT", FREE_TIER_LIMIT);
    let coffee = env_limit_value("API_RATE_LIMIT_COFFEE_TIER_LIMIT", COFFEE_TIER_LIMIT);
    let unlimited = unlimited_roles();

    RateLimitPolicy {
        free: Some(free).filter(|limit| *limit > 0),
        coffee: Some(coffee).filter(|limit| *limit > 0),
        pro: if unlimited.iter().any(|value| value == "pro") {
            None
        } else {
            None
        },
        unlimited_roles: unlimited,
    }
}

fn get_client_ip(request: &Request) -> String {
    let forwarded_for = request
        .headers()
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
        .and_then(|raw| raw.split(',').next())
        .map(|v| v.trim());

    let direct_ip = request
        .headers()
        .get("x-real-ip")
        .and_then(|value| value.to_str().ok())
        .map(|v| v.trim());

    forwarded_for
        .or(direct_ip)
        .filter(|value| !value.is_empty())
        .unwrap_or("anonymous")
        .to_string()
}
fn resolve_subject_and_role(
    auth_user: Option<&AuthUser>,
    jar: &CookieJar,
    ip: &str,
) -> (String, String) {
    if let Some(user) = auth_user {
        return (format!("user:{}", user.id), user.role.clone());
    }

    if let Some(token) = jar
        .get("access_token")
        .and_then(|cookie| tokens::verify_access_token(cookie.value(), &env::var("JWT_SECRET").ok()?).ok())
    {
        return (format!("user:{}", token.sub), token.role);
    }

    (format!("ip:{}", hash_identity(ip)), "free".to_string())
}

fn hash_identity(ip: &str) -> String {
    let mut hasher = Sha256::new();
    let salt = env::var("API_RATE_LIMIT_IP_SALT").unwrap_or_else(|_| "rail-salt".to_string());
    hasher.update(salt.as_bytes());
    hasher.update(ip.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn next_window_reset_unix_ts() -> i64 {
    let tomorrow = Utc::now().date_naive() + Duration::days(1);
    let midnight = tomorrow.and_hms_opt(0, 0, 0).expect("valid UTC midnight");
    Utc.from_utc_datetime(&midnight).timestamp()
}

fn rate_limit_headers(headers: &mut axum::http::HeaderMap, used: i64, limit: i64) {
    let remaining = (limit - used).max(0);
    let reset_at = next_window_reset_unix_ts();
    headers.insert(
        "X-RateLimit-Limit",
        HeaderValue::from_str(&limit.to_string()).unwrap_or(HeaderValue::from_static("0")),
    );
    headers.insert(
        "X-RateLimit-Remaining",
        HeaderValue::from_str(&remaining.to_string()).unwrap_or(HeaderValue::from_static("0")),
    );
    headers.insert(
        "X-RateLimit-Reset",
        HeaderValue::from_str(&reset_at.to_string()).unwrap_or(HeaderValue::from_static("0")),
    );
}

pub async fn graphql_rate_limit(
    State(state): State<AppState>,
    jar: CookieJar,
    request: Request,
    next: Next,
) -> Response {
    if matches!(request.method(), &Method::GET | &Method::OPTIONS) {
        return next.run(request).await;
    }

    let maybe_user = request
        .extensions()
        .get::<Option<AuthUser>>()
        .and_then(std::option::Option::as_ref);
    let ip = get_client_ip(&request);
    let (subject, role) = resolve_subject_and_role(maybe_user, &jar, &ip);
    let Some(limit) = plan_limit(&role) else {
        return next.run(request).await;
    };
    let usage = match usage_store::record_graphql_request(&state.pool, &subject, &role).await {
        Ok(usage) => usage,
        Err(error) => {
            tracing::warn!(
                "rate limit tracking failed for subject {} role {}: {}",
                subject,
                role,
                error
            );
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(RateLimitPayload {
                    error: "rate limit service unavailable".to_string(),
                    used: 0,
                    limit: Some(limit),
                    remaining: Some(0),
                    reset_at: next_window_reset_unix_ts(),
                }),
            )
                .into_response();
        }
    };

    if usage.request_count > limit {
        let mut response = (
            StatusCode::TOO_MANY_REQUESTS,
            Json(RateLimitPayload {
                error: "rate limit exceeded".to_string(),
                used: usage.request_count,
                limit: Some(limit),
                remaining: Some(0),
                reset_at: next_window_reset_unix_ts(),
            }),
        )
            .into_response();
        rate_limit_headers(response.headers_mut(), usage.request_count, limit);
        return response;
    }

    let mut response = next.run(request).await;
    rate_limit_headers(response.headers_mut(), usage.request_count, limit);
    response
}
