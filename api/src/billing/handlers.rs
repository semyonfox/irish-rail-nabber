use std::{net::IpAddr, sync::OnceLock, time::Duration as StdDuration};

use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    Extension, Json,
};
use chrono::{DateTime, Duration, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use standardwebhooks::{Webhook, HEADER_WEBHOOK_ID};
use uuid::Uuid;

use crate::{
    auth::clerk,
    db,
    db::users::{self, PolarStateApply, PolarStateUpdate},
    models::AuthUser,
    rate_limit,
    rate_limit::plan_limit,
    state::AppState,
};

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PaidPlan {
    Coffee,
    Pro,
}

impl PaidPlan {
    fn as_str(self) -> &'static str {
        match self {
            Self::Coffee => "coffee",
            Self::Pro => "pro",
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct CheckoutRequest {
    pub plan: PaidPlan,
}

#[derive(Debug, Serialize)]
pub struct UrlResponse {
    pub url: String,
}

#[derive(Debug, Serialize)]
pub struct ErrorResponse {
    pub error: String,
}

fn json_error(status: StatusCode, message: &str) -> (StatusCode, Json<ErrorResponse>) {
    (
        status,
        Json(ErrorResponse {
            error: message.to_string(),
        }),
    )
}

#[derive(Clone)]
struct PolarConfig {
    access_token: String,
    webhook_secret: String,
    organization_id: String,
    coffee_product_id: String,
    pro_product_id: String,
    api_base_url: &'static str,
}

impl PolarConfig {
    fn from_env() -> Result<Self, String> {
        let required = |name: &str| {
            std::env::var(name)
                .ok()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| format!("missing {name}"))
        };

        let environment = required("POLAR_ENVIRONMENT")?;
        let api_base_url = match environment.to_ascii_lowercase().as_str() {
            "sandbox" => "https://sandbox-api.polar.sh/v1",
            "production" => "https://api.polar.sh/v1",
            _ => return Err("POLAR_ENVIRONMENT must be sandbox or production".to_string()),
        };

        let organization_id = required("POLAR_ORGANIZATION_ID")?;
        let coffee_product_id = required("POLAR_COFFEE_PRODUCT_ID")?;
        let pro_product_id = required("POLAR_PRO_PRODUCT_ID")?;
        for (name, value) in [
            ("POLAR_ORGANIZATION_ID", &organization_id),
            ("POLAR_COFFEE_PRODUCT_ID", &coffee_product_id),
            ("POLAR_PRO_PRODUCT_ID", &pro_product_id),
        ] {
            Uuid::parse_str(value).map_err(|_| format!("invalid {name}"))?;
        }
        if coffee_product_id == pro_product_id {
            return Err("Polar product IDs must be different".to_string());
        }

        let webhook_secret = required("POLAR_WEBHOOK_SECRET")?;
        Webhook::new(&webhook_secret).map_err(|_| "invalid POLAR_WEBHOOK_SECRET".to_string())?;

        Ok(Self {
            access_token: required("POLAR_ACCESS_TOKEN")?,
            webhook_secret,
            organization_id,
            coffee_product_id,
            pro_product_id,
            api_base_url,
        })
    }

    fn product_id(&self, plan: PaidPlan) -> &str {
        match plan {
            PaidPlan::Coffee => &self.coffee_product_id,
            PaidPlan::Pro => &self.pro_product_id,
        }
    }
}

fn checkout_enabled_flag() -> bool {
    std::env::var("POLAR_CHECKOUT_ENABLED")
        .ok()
        .is_some_and(|value| matches!(value.to_ascii_lowercase().as_str(), "1" | "true" | "yes"))
}

pub fn billing_enabled() -> bool {
    checkout_enabled_flag() && PolarConfig::from_env().is_ok()
}

fn polar_config() -> Result<PolarConfig, (StatusCode, Json<ErrorResponse>)> {
    PolarConfig::from_env().map_err(|error| {
        tracing::warn!("Polar billing is not configured: {error}");
        json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "billing is temporarily unavailable",
        )
    })
}

fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(StdDuration::from_secs(10))
            .build()
            .expect("Polar HTTP client")
    })
}

fn app_url() -> String {
    std::env::var("APP_URL")
        .unwrap_or_else(|_| "http://localhost:3000".to_string())
        .trim_end_matches('/')
        .to_string()
}

fn customer_ip(headers: &HeaderMap) -> Option<String> {
    headers
        .get("cf-connecting-ip")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<IpAddr>().ok())
        .map(|value| value.to_string())
}

#[derive(Serialize)]
struct PolarCheckoutCreate<'a> {
    products: [&'a str; 1],
    external_customer_id: String,
    customer_email: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    customer_ip_address: Option<String>,
    success_url: String,
    return_url: String,
    currency: &'static str,
    locale: &'static str,
    metadata: serde_json::Value,
}

#[derive(Deserialize)]
struct PolarCheckoutResponse {
    url: String,
}

pub async fn checkout(
    State(state): State<AppState>,
    Extension(auth_user): Extension<Option<AuthUser>>,
    headers: HeaderMap,
    Json(body): Json<CheckoutRequest>,
) -> Result<Json<UrlResponse>, (StatusCode, Json<ErrorResponse>)> {
    if !checkout_enabled_flag() {
        return Err(json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "billing is temporarily unavailable",
        ));
    }

    let auth_user =
        auth_user.ok_or_else(|| json_error(StatusCode::UNAUTHORIZED, "not authenticated"))?;
    if auth_user.role != "free" {
        return Err(json_error(
            StatusCode::CONFLICT,
            "manage your existing subscription from the account page",
        ));
    }

    let user = users::find_user_by_id(&state.pool, auth_user.id)
        .await
        .map_err(|_| json_error(StatusCode::INTERNAL_SERVER_ERROR, "database error"))?
        .ok_or_else(|| json_error(StatusCode::UNAUTHORIZED, "user not found"))?;
    let config = polar_config()?;
    let root = app_url();
    let request = PolarCheckoutCreate {
        products: [config.product_id(body.plan)],
        external_customer_id: user.id.to_string(),
        customer_email: &user.email,
        customer_ip_address: customer_ip(&headers),
        success_url: format!("{root}/account?checkout=success&checkout_id={{CHECKOUT_ID}}"),
        return_url: format!("{root}/pricing"),
        currency: "eur",
        locale: "en-IE",
        metadata: serde_json::json!({
            "app_user_id": user.id.to_string(),
            "plan": body.plan.as_str(),
        }),
    };

    let response = http()
        .post(format!("{}/checkouts", config.api_base_url))
        .bearer_auth(&config.access_token)
        .json(&request)
        .send()
        .await
        .map_err(|error| {
            tracing::warn!("Polar checkout request failed: {error}");
            json_error(StatusCode::BAD_GATEWAY, "could not start checkout")
        })?;
    let status = response.status();
    if !status.is_success() {
        tracing::warn!("Polar checkout returned {status}");
        return Err(json_error(
            StatusCode::BAD_GATEWAY,
            "could not start checkout",
        ));
    }
    let checkout = response
        .json::<PolarCheckoutResponse>()
        .await
        .map_err(|error| {
            tracing::warn!("Polar checkout response was invalid: {error}");
            json_error(StatusCode::BAD_GATEWAY, "could not start checkout")
        })?;

    Ok(Json(UrlResponse { url: checkout.url }))
}

#[derive(Serialize)]
struct PolarCustomerSessionCreate<'a> {
    customer_id: &'a str,
    return_url: String,
}

#[derive(Deserialize)]
struct PolarCustomerSessionResponse {
    customer_portal_url: String,
}

pub async fn portal(
    State(state): State<AppState>,
    Extension(auth_user): Extension<Option<AuthUser>>,
) -> Result<Json<UrlResponse>, (StatusCode, Json<ErrorResponse>)> {
    let auth_user =
        auth_user.ok_or_else(|| json_error(StatusCode::UNAUTHORIZED, "not authenticated"))?;
    let user = users::find_user_by_id(&state.pool, auth_user.id)
        .await
        .map_err(|_| json_error(StatusCode::INTERNAL_SERVER_ERROR, "database error"))?
        .ok_or_else(|| json_error(StatusCode::UNAUTHORIZED, "user not found"))?;
    let customer_id = user
        .polar_customer_id
        .as_deref()
        .ok_or_else(|| json_error(StatusCode::BAD_REQUEST, "no billing account found"))?;

    let config = polar_config()?;
    let request = PolarCustomerSessionCreate {
        customer_id,
        return_url: format!("{}/account", app_url()),
    };
    let response = http()
        .post(format!("{}/customer-sessions", config.api_base_url))
        .bearer_auth(&config.access_token)
        .json(&request)
        .send()
        .await
        .map_err(|error| {
            tracing::warn!("Polar portal request failed: {error}");
            json_error(StatusCode::BAD_GATEWAY, "could not open billing portal")
        })?;
    let status = response.status();
    if !status.is_success() {
        tracing::warn!("Polar portal returned {status}");
        return Err(json_error(
            StatusCode::BAD_GATEWAY,
            "could not open billing portal",
        ));
    }
    let session = response
        .json::<PolarCustomerSessionResponse>()
        .await
        .map_err(|error| {
            tracing::warn!("Polar portal response was invalid: {error}");
            json_error(StatusCode::BAD_GATEWAY, "could not open billing portal")
        })?;

    Ok(Json(UrlResponse {
        url: session.customer_portal_url,
    }))
}

#[derive(Debug, Deserialize)]
struct PolarWebhookEvent {
    #[serde(rename = "type")]
    event_type: String,
    timestamp: DateTime<Utc>,
    data: serde_json::Value,
}

#[derive(Debug, Deserialize)]
struct PolarCustomerState {
    id: String,
    organization_id: String,
    external_id: Option<String>,
    active_subscriptions: Vec<PolarSubscription>,
}

#[derive(Debug, Deserialize)]
struct PolarSubscription {
    id: String,
    product_id: String,
}

fn entitlement<'a>(
    subscriptions: &'a [PolarSubscription],
    config: &PolarConfig,
) -> (&'static str, Option<&'a str>) {
    // Customer State already filters this collection using Polar's configured
    // payment-recovery grace period, so it is the entitlement boundary.
    if let Some(subscription) = subscriptions
        .iter()
        .find(|subscription| subscription.product_id == config.pro_product_id)
    {
        return ("pro", Some(subscription.id.as_str()));
    }

    if let Some(subscription) = subscriptions
        .iter()
        .find(|subscription| subscription.product_id == config.coffee_product_id)
    {
        return ("coffee", Some(subscription.id.as_str()));
    }

    ("free", None)
}

pub async fn webhook(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    let config = match PolarConfig::from_env() {
        Ok(config) => config,
        Err(error) => {
            tracing::error!("Polar webhook is not configured: {error}");
            return StatusCode::SERVICE_UNAVAILABLE;
        }
    };
    let verifier = match Webhook::new(&config.webhook_secret) {
        Ok(verifier) => verifier,
        Err(error) => {
            tracing::error!("Polar webhook secret is invalid: {error}");
            return StatusCode::SERVICE_UNAVAILABLE;
        }
    };
    if let Err(error) = verifier.verify(&body, &headers) {
        tracing::warn!("Polar webhook signature rejected: {error}");
        return StatusCode::FORBIDDEN;
    }

    let Some(event_id) = headers
        .get(HEADER_WEBHOOK_ID)
        .and_then(|value| value.to_str().ok())
    else {
        return StatusCode::BAD_REQUEST;
    };
    let event = match serde_json::from_slice::<PolarWebhookEvent>(&body) {
        Ok(event) => event,
        Err(error) => {
            tracing::warn!("Polar webhook payload was invalid: {error}");
            return StatusCode::BAD_REQUEST;
        }
    };

    let PolarWebhookEvent {
        event_type,
        timestamp,
        data,
    } = event;
    if event_type != "customer.state_changed" {
        tracing::debug!(event_id, event_type, "ignored Polar webhook");
        return StatusCode::ACCEPTED;
    }
    let data = match serde_json::from_value::<PolarCustomerState>(data) {
        Ok(data) => data,
        Err(error) => {
            tracing::warn!(event_id, "Polar customer state was invalid: {error}");
            return StatusCode::BAD_REQUEST;
        }
    };
    if data.organization_id != config.organization_id {
        tracing::warn!(event_id, "Polar webhook organization did not match");
        return StatusCode::FORBIDDEN;
    }

    let stored_user_id = match users::find_user_id_by_polar_customer(&state.pool, &data.id).await {
        Ok(user_id) => user_id,
        Err(error) => {
            tracing::error!(event_id, "Polar customer lookup failed: {error}");
            return StatusCode::INTERNAL_SERVER_ERROR;
        }
    };
    // Polar clears external_id when a customer is deleted. Once linked, the
    // provider customer ID remains our stable route for the final downgrade.
    let user_id = stored_user_id.or_else(|| {
        data.external_id
            .as_deref()
            .and_then(|external_id| Uuid::parse_str(external_id).ok())
    });
    let Some(user_id) = user_id else {
        tracing::debug!(event_id, "ignored unlinked Polar customer");
        return StatusCode::ACCEPTED;
    };
    let (role, subscription_id) = entitlement(&data.active_subscriptions, &config);

    let result = users::apply_polar_state(
        &state.pool,
        PolarStateUpdate {
            event_id,
            event_type: &event_type,
            occurred_at: timestamp,
            user_id,
            customer_id: &data.id,
            subscription_id,
            role,
        },
    )
    .await;

    match result {
        Ok(PolarStateApply::Applied { clerk_user_id }) => {
            if let Some(clerk_user_id) = clerk_user_id {
                clerk::invalidate_user(&clerk_user_id).await;
            }
            StatusCode::ACCEPTED
        }
        Ok(PolarStateApply::Duplicate | PolarStateApply::Stale) => StatusCode::ACCEPTED,
        Ok(PolarStateApply::MissingUser) => {
            tracing::warn!(event_id, "Polar webhook user does not exist yet");
            StatusCode::INTERNAL_SERVER_ERROR
        }
        Err(error) => {
            tracing::error!(event_id, "Polar webhook database update failed: {error}");
            StatusCode::INTERNAL_SERVER_ERROR
        }
    }
}

#[derive(Debug, Serialize)]
pub struct UsageResponse {
    pub used: i64,
    pub limit: Option<i64>,
    pub remaining: Option<i64>,
    pub reset_at: i64,
    pub role: String,
}

pub async fn usage(
    State(state): State<AppState>,
    Extension(auth_user): Extension<Option<AuthUser>>,
) -> Result<Json<UsageResponse>, (StatusCode, Json<ErrorResponse>)> {
    let auth_user =
        auth_user.ok_or_else(|| json_error(StatusCode::UNAUTHORIZED, "not authenticated"))?;
    let subject = format!("user:{}", auth_user.id);
    let usage = db::usage::get_subject_usage(&state.pool, &subject)
        .await
        .map_err(|_| json_error(StatusCode::INTERNAL_SERVER_ERROR, "database error"))?
        .unwrap_or(db::usage::DailyUsageRecord {
            request_count: 0,
            role_snapshot: auth_user.role.clone(),
            for_date: Utc::now().date_naive(),
        });

    let limit = plan_limit(&auth_user.role);
    let remaining = limit.map(|tier_limit| (tier_limit - usage.request_count).max(0));
    let tomorrow = Utc::now().date_naive() + Duration::days(1);
    let reset_at = Utc
        .from_utc_datetime(&tomorrow.and_hms_opt(0, 0, 0).expect("valid midnight"))
        .timestamp();

    Ok(Json(UsageResponse {
        used: usage.request_count,
        limit,
        remaining,
        reset_at,
        role: auth_user.role,
    }))
}

#[derive(Debug, Serialize)]
pub struct RateLimitsResponse {
    pub free: Option<i64>,
    pub coffee: Option<i64>,
    pub pro: Option<i64>,
    pub unlimited_roles: Vec<String>,
}

pub async fn limits() -> Json<RateLimitsResponse> {
    let policy = rate_limit::rate_limit_policy();
    Json(RateLimitsResponse {
        free: policy.free,
        coffee: policy.coffee,
        pro: policy.pro,
        unlimited_roles: policy.unlimited_roles,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> PolarConfig {
        PolarConfig {
            access_token: "test".to_string(),
            webhook_secret: "whsec_dGVzdA==".to_string(),
            organization_id: Uuid::nil().to_string(),
            coffee_product_id: "11111111-1111-4111-8111-111111111111".to_string(),
            pro_product_id: "22222222-2222-4222-8222-222222222222".to_string(),
            api_base_url: "https://sandbox-api.polar.sh/v1",
        }
    }

    fn subscription(id: &str, product_id: &str) -> PolarSubscription {
        PolarSubscription {
            id: id.to_string(),
            product_id: product_id.to_string(),
        }
    }

    #[test]
    fn checkout_accepts_only_known_plan_slugs() {
        let coffee = serde_json::from_str::<CheckoutRequest>(r#"{"plan":"coffee"}"#).unwrap();
        assert_eq!(coffee.plan, PaidPlan::Coffee);
        assert!(serde_json::from_str::<CheckoutRequest>(r#"{"plan":"price_123"}"#).is_err());
    }

    #[test]
    fn active_pro_subscription_takes_priority() {
        let config = config();
        let subscriptions = vec![
            subscription("coffee-sub", &config.coffee_product_id),
            subscription("pro-sub", &config.pro_product_id),
        ];

        assert_eq!(
            entitlement(&subscriptions, &config),
            ("pro", Some("pro-sub"))
        );
    }

    #[test]
    fn unknown_active_subscriptions_do_not_grant_access() {
        let config = config();
        let subscriptions = vec![subscription(
            "foreign",
            "33333333-3333-4333-8333-333333333333",
        )];

        assert_eq!(entitlement(&subscriptions, &config), ("free", None));
    }

    #[test]
    fn cloudflare_customer_ip_must_be_valid() {
        let mut headers = HeaderMap::new();
        headers.insert("cf-connecting-ip", "203.0.113.8".parse().unwrap());
        assert_eq!(customer_ip(&headers).as_deref(), Some("203.0.113.8"));

        headers.insert("cf-connecting-ip", "not-an-ip".parse().unwrap());
        assert_eq!(customer_ip(&headers), None);
    }

    #[test]
    fn checkout_payload_uses_product_and_external_customer_ids() {
        let product_id = "11111111-1111-4111-8111-111111111111";
        let user_id = Uuid::nil().to_string();
        let request = PolarCheckoutCreate {
            products: [product_id],
            external_customer_id: user_id.clone(),
            customer_email: "person@example.com",
            customer_ip_address: Some("203.0.113.8".to_string()),
            success_url: "https://traein.semyon.ie/account?checkout=success".to_string(),
            return_url: "https://traein.semyon.ie/pricing".to_string(),
            currency: "eur",
            locale: "en-IE",
            metadata: serde_json::json!({ "app_user_id": user_id, "plan": "coffee" }),
        };

        let value = serde_json::to_value(request).unwrap();
        assert_eq!(value["products"], serde_json::json!([product_id]));
        assert_eq!(value["external_customer_id"], Uuid::nil().to_string());
        assert_eq!(value["currency"], "eur");
        assert!(value.get("price_id").is_none());
    }

    #[test]
    fn portal_payload_uses_polar_customer_id() {
        let request = PolarCustomerSessionCreate {
            customer_id: "992fae2a-2a17-4b7a-8d9e-e287cf90131b",
            return_url: "https://traein.semyon.ie/account".to_string(),
        };

        let value = serde_json::to_value(request).unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "customer_id": "992fae2a-2a17-4b7a-8d9e-e287cf90131b",
                "return_url": "https://traein.semyon.ie/account",
            })
        );
    }

    #[test]
    fn current_customer_state_fixture_maps_to_entitlement() {
        let config = config();
        let payload = serde_json::json!({
            "type": "customer.state_changed",
            "timestamp": "2026-09-12T10:00:00Z",
            "api_version": "2026-04",
            "data": {
                "id": "992fae2a-2a17-4b7a-8d9e-e287cf90131b",
                "organization_id": config.organization_id,
                "external_id": Uuid::nil().to_string(),
                "active_subscriptions": [{
                    "id": "e5149aae-e521-42b9-b24c-abb3d71eea2e",
                    "product_id": config.coffee_product_id,
                    "status": "active",
                    "amount": 500,
                    "currency": "eur"
                }]
            }
        });

        let event: PolarWebhookEvent = serde_json::from_value(payload).unwrap();
        assert_eq!(event.event_type, "customer.state_changed");
        let data: PolarCustomerState = serde_json::from_value(event.data).unwrap();
        assert_eq!(
            entitlement(&data.active_subscriptions, &config),
            ("coffee", Some("e5149aae-e521-42b9-b24c-abb3d71eea2e"))
        );
    }

    #[test]
    fn webhook_envelope_accepts_unrelated_event_payloads() {
        let event: PolarWebhookEvent = serde_json::from_value(serde_json::json!({
            "type": "order.created",
            "timestamp": "2026-09-12T10:00:00Z",
            "data": { "id": "not-a-customer-state" }
        }))
        .unwrap();

        assert_eq!(event.event_type, "order.created");
    }

    #[test]
    fn customer_state_requires_active_subscriptions() {
        let payload = serde_json::json!({
            "id": "992fae2a-2a17-4b7a-8d9e-e287cf90131b",
            "organization_id": Uuid::nil().to_string(),
            "external_id": Uuid::nil().to_string()
        });

        assert!(serde_json::from_value::<PolarCustomerState>(payload).is_err());
    }
}
