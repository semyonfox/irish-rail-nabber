use std::{
    env,
    net::{AddrParseError, IpAddr, SocketAddr},
};

use axum::{
    extract::{ConnectInfo, Request, State},
    http::{HeaderValue, Method, StatusCode},
    middleware::Next,
    response::{IntoResponse, Json, Response},
};
use chrono::{Duration, TimeZone, Utc};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::{db::usage as usage_store, models::AuthUser, state::AppState};

#[derive(Debug, Serialize)]
struct RateLimitPayload {
    error: String,
    used: i64,
    limit: Option<i64>,
    remaining: Option<i64>,
    reset_at: i64,
}

// The live dashboard polls several GraphQL queries continuously. These limits are
// deliberately sized for an always-open operations screen, not a typical page view.
const FREE_TIER_LIMIT: i64 = 25_000;
const COFFEE_TIER_LIMIT: i64 = 100_000;
const BILLING_CHECKOUT_DAILY_LIMIT: i64 = 10;
const BILLING_PORTAL_DAILY_LIMIT: i64 = 30;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BillingAction {
    Checkout,
    Portal,
}

impl BillingAction {
    fn bucket(self) -> &'static str {
        match self {
            Self::Checkout => "checkout",
            Self::Portal => "portal",
        }
    }

    fn daily_limit(self) -> i64 {
        match self {
            Self::Checkout => BILLING_CHECKOUT_DAILY_LIMIT,
            Self::Portal => BILLING_PORTAL_DAILY_LIMIT,
        }
    }
}

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
    let free = env_limit_value("API_RATE_LIMIT_FREE_TIER_LIMIT", FREE_TIER_LIMIT);
    let coffee = env_limit_value("API_RATE_LIMIT_COFFEE_TIER_LIMIT", COFFEE_TIER_LIMIT);
    let unlimited_roles = unlimited_roles();

    configured_plan_limit(role, free, coffee, &unlimited_roles)
}

fn configured_plan_limit(
    role: &str,
    free: i64,
    coffee: i64,
    unlimited_roles: &[String],
) -> Option<i64> {
    let role = role.to_lowercase();
    if unlimited_roles.iter().any(|value| value == &role) {
        return None;
    }

    let limit = if role == "coffee" { coffee } else { free };
    // Zero disables the cap. This matches the null value exposed by /billing/limits.
    (limit > 0).then_some(limit)
}

pub fn rate_limit_policy() -> RateLimitPolicy {
    let free = env_limit_value("API_RATE_LIMIT_FREE_TIER_LIMIT", FREE_TIER_LIMIT);
    let coffee = env_limit_value("API_RATE_LIMIT_COFFEE_TIER_LIMIT", COFFEE_TIER_LIMIT);
    let unlimited = unlimited_roles();

    RateLimitPolicy {
        free: configured_plan_limit("free", free, coffee, &unlimited),
        coffee: configured_plan_limit("coffee", free, coffee, &unlimited),
        pro: configured_plan_limit("pro", free, coffee, &unlimited),
        unlimited_roles: unlimited,
    }
}

#[derive(Clone)]
pub struct ClientIpConfig {
    trusted_proxies: Vec<IpAddr>,
}

impl ClientIpConfig {
    pub fn from_env() -> Result<Self, AddrParseError> {
        let trusted_proxies = env::var("API_RATE_LIMIT_TRUSTED_PROXIES")
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::parse)
            .collect::<Result<Vec<IpAddr>, _>>()?;

        let salt = env::var("API_RATE_LIMIT_IP_SALT").unwrap_or_default();
        if salt.trim().is_empty() || salt.trim() == "rail-salt" {
            tracing::warn!("API_RATE_LIMIT_IP_SALT must be a strong random value in production");
        }

        Ok(Self { trusted_proxies })
    }
}

fn get_client_ip(request: &Request) -> String {
    let Some(ConnectInfo(peer)) = request.extensions().get::<ConnectInfo<SocketAddr>>() else {
        return "anonymous".to_string();
    };
    let peer = peer.ip();
    let Some(config) = request
        .extensions()
        .get::<ClientIpConfig>()
        .filter(|config| config.trusted_proxies.contains(&peer))
    else {
        return peer.to_string();
    };

    let mut headers = request.headers().get_all("x-forwarded-for").iter();
    let Some(header) = headers.next() else {
        return peer.to_string();
    };
    // ambiguous or malformed chains must not choose a client-controlled identity
    if headers.next().is_some() {
        return peer.to_string();
    }
    let Ok(raw) = header.to_str() else {
        return peer.to_string();
    };
    let Ok(addresses) = raw
        .split(',')
        .map(|value| value.trim().parse::<IpAddr>())
        .collect::<Result<Vec<_>, _>>()
    else {
        return peer.to_string();
    };

    let mut client = peer;
    for address in addresses.into_iter().rev() {
        if !config.trusted_proxies.contains(&client) {
            break;
        }
        client = address;
    }
    client.to_string()
}

fn resolve_subject_and_role(auth_user: Option<&AuthUser>, ip: &str) -> (String, String) {
    if let Some(user) = auth_user {
        return (format!("user:{}", user.id), user.role.clone());
    }

    (format!("ip:{}", hash_identity(ip)), "free".to_string())
}

fn billing_subject(action: BillingAction, user: &AuthUser) -> String {
    format!("billing:{}:user:{}", action.bucket(), user.id)
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

fn request_exceeds_limit(request_count: i64, limit: i64) -> bool {
    request_count > limit
}

fn exceeded_plan_limit(request_count: i64, limit: Option<i64>) -> Option<i64> {
    limit.filter(|limit| request_exceeds_limit(request_count, *limit))
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
    let (subject, role) = resolve_subject_and_role(maybe_user, &ip);
    let limit = plan_limit(&role);
    let usage = match usage_store::record_daily_request(&state.pool, &subject, &role).await {
        Ok(usage) => usage,
        Err(error) => {
            tracing::warn!(
                "rate limit tracking failed for subject {} role {}: {}",
                subject,
                role,
                error
            );
            let Some(limit) = limit else {
                return next.run(request).await;
            };
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

    if let Some(limit) = exceeded_plan_limit(usage.request_count, limit) {
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
    if let Some(limit) = limit {
        rate_limit_headers(response.headers_mut(), usage.request_count, limit);
    }
    response
}

async fn billing_action_rate_limit(
    state: AppState,
    request: Request,
    next: Next,
    action: BillingAction,
) -> Response {
    let Some(user) = request
        .extensions()
        .get::<Option<AuthUser>>()
        .and_then(std::option::Option::as_ref)
    else {
        return next.run(request).await;
    };

    let limit = action.daily_limit();
    let subject = billing_subject(action, user);
    let usage = match usage_store::record_daily_request(&state.pool, &subject, &user.role).await {
        Ok(usage) => usage,
        Err(error) => {
            tracing::warn!(
                action = action.bucket(),
                user_id = %user.id,
                "billing rate limit tracking failed: {error}"
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

    if request_exceeds_limit(usage.request_count, limit) {
        let mut response = (
            StatusCode::TOO_MANY_REQUESTS,
            Json(RateLimitPayload {
                error: "billing request limit exceeded".to_string(),
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

pub async fn billing_checkout_rate_limit(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    billing_action_rate_limit(state, request, next, BillingAction::Checkout).await
}

pub async fn billing_portal_rate_limit(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    billing_action_rate_limit(state, request, next, BillingAction::Portal).await
}

#[cfg(test)]
mod tests {
    use uuid::Uuid;

    use super::{
        billing_subject, configured_plan_limit, exceeded_plan_limit, request_exceeds_limit,
        BillingAction,
    };
    use crate::models::AuthUser;

    #[test]
    fn untrusted_peer_cannot_spoof_forwarding_headers() {
        let mut request = axum::http::Request::builder()
            .header("x-forwarded-for", "198.51.100.1")
            .header("x-real-ip", "198.51.100.2")
            .body(axum::body::Body::empty())
            .unwrap();
        request.extensions_mut().insert(axum::extract::ConnectInfo(
            "192.0.2.10:1234".parse::<std::net::SocketAddr>().unwrap(),
        ));
        assert_eq!(super::get_client_ip(&request), "192.0.2.10");
        let request = proxy_request(Some("198.51.100.10:1234"), "198.51.100.99");
        assert_eq!(super::get_client_ip(&request), "198.51.100.10");
    }

    fn proxy_request(peer: Option<&str>, forwarded: &str) -> axum::extract::Request {
        let mut request = axum::http::Request::builder()
            .header("x-forwarded-for", forwarded)
            .body(axum::body::Body::empty())
            .unwrap();
        if let Some(peer) = peer {
            request.extensions_mut().insert(axum::extract::ConnectInfo(
                peer.parse::<std::net::SocketAddr>().unwrap(),
            ));
        }
        request.extensions_mut().insert(super::ClientIpConfig {
            trusted_proxies: vec![
                "192.0.2.10".parse().unwrap(),
                "2001:db8::1".parse().unwrap(),
            ],
        });
        request
    }

    #[test]
    fn trusted_proxy_chain_stops_before_spoofed_prefix() {
        let request = proxy_request(
            Some("192.0.2.10:1234"),
            "198.51.100.99, 198.51.100.1, 2001:db8::1",
        );
        assert_eq!(super::get_client_ip(&request), "198.51.100.1");
        let request = proxy_request(Some("[2001:db8::1]:1234"), "2001:db8::2");
        assert_eq!(super::get_client_ip(&request), "2001:db8::2");
    }

    #[test]
    fn malformed_or_duplicate_forwarding_headers_use_peer() {
        for header in ["", "unknown", "198.51.100.1, invalid", "198.51.100.1,"] {
            let request = proxy_request(Some("192.0.2.10:1234"), header);
            assert_eq!(super::get_client_ip(&request), "192.0.2.10");
        }
        let mut request = proxy_request(Some("192.0.2.10:1234"), "198.51.100.1");
        request
            .headers_mut()
            .append("x-forwarded-for", "198.51.100.2".parse().unwrap());
        assert_eq!(super::get_client_ip(&request), "192.0.2.10");
        request.headers_mut().remove("x-forwarded-for");
        request
            .headers_mut()
            .insert("x-real-ip", "198.51.100.3".parse().unwrap());
        request
            .headers_mut()
            .insert("cf-connecting-ip", "198.51.100.4".parse().unwrap());
        assert_eq!(super::get_client_ip(&request), "192.0.2.10");
    }

    #[test]
    fn missing_peer_does_not_trust_headers() {
        let request = proxy_request(None, "198.51.100.1");
        assert_eq!(super::get_client_ip(&request), "anonymous");
    }

    fn roles(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn plan_limits_match_each_tier() {
        let unlimited = roles(&["pro", "admin"]);

        assert_eq!(
            configured_plan_limit("free", 25_000, 100_000, &unlimited),
            Some(25_000)
        );
        assert_eq!(
            configured_plan_limit("coffee", 25_000, 100_000, &unlimited),
            Some(100_000)
        );
        assert_eq!(
            configured_plan_limit("pro", 25_000, 100_000, &unlimited),
            None
        );
        assert_eq!(
            configured_plan_limit("admin", 25_000, 100_000, &unlimited),
            None
        );
    }

    #[test]
    fn zero_means_unlimited() {
        let unlimited = Vec::new();

        assert_eq!(configured_plan_limit("free", 0, 100_000, &unlimited), None);
        assert_eq!(configured_plan_limit("coffee", 25_000, 0, &unlimited), None);
    }

    #[test]
    fn pro_uses_free_limit_when_not_explicitly_unlimited() {
        assert_eq!(
            configured_plan_limit("pro", 25_000, 100_000, &Vec::new()),
            Some(25_000)
        );
    }

    #[test]
    fn unlimited_plan_never_exceeds_a_ceiling() {
        assert_eq!(exceeded_plan_limit(1, None), None);
        assert_eq!(exceeded_plan_limit(i64::MAX, None), None);
        assert_eq!(exceeded_plan_limit(25_000, Some(25_000)), None);
        assert_eq!(exceeded_plan_limit(25_001, Some(25_000)), Some(25_000));
    }

    #[test]
    fn billing_actions_have_small_independent_daily_buckets() {
        let user = AuthUser {
            id: Uuid::nil(),
            email: "person@example.com".to_string(),
            role: "free".to_string(),
        };

        assert_eq!(BillingAction::Checkout.daily_limit(), 10);
        assert_eq!(BillingAction::Portal.daily_limit(), 30);
        assert_eq!(
            billing_subject(BillingAction::Checkout, &user),
            "billing:checkout:user:00000000-0000-0000-0000-000000000000"
        );
        assert_eq!(
            billing_subject(BillingAction::Portal, &user),
            "billing:portal:user:00000000-0000-0000-0000-000000000000"
        );

        assert!(!request_exceeds_limit(
            10,
            BillingAction::Checkout.daily_limit()
        ));
        assert!(request_exceeds_limit(
            11,
            BillingAction::Checkout.daily_limit()
        ));
        assert!(!request_exceeds_limit(
            30,
            BillingAction::Portal.daily_limit()
        ));
        assert!(request_exceeds_limit(
            31,
            BillingAction::Portal.daily_limit()
        ));
    }
}
