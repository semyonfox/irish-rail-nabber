use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    Extension, Json,
};
use serde::{Deserialize, Serialize};
use stripe::{
    BillingPortalSession, CheckoutSession, CheckoutSessionMode, Client as StripeClient,
    CreateBillingPortalSession, CreateCheckoutSession, CreateCheckoutSessionLineItems, Event,
    EventObject, Webhook,
};
use uuid::Uuid;

use crate::{db::users, models::AuthUser, state::AppState};

#[derive(Debug, Deserialize)]
pub struct CheckoutRequest {
    pub price_id: String,
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

fn stripe_client() -> Result<StripeClient, (StatusCode, Json<ErrorResponse>)> {
    let key = std::env::var("STRIPE_SECRET_KEY").map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "missing STRIPE_SECRET_KEY",
        )
    })?;
    Ok(StripeClient::new(key))
}

fn app_url() -> String {
    std::env::var("APP_URL").unwrap_or_else(|_| "http://localhost:3000".to_string())
}

fn role_from_price(price_id: &str) -> &'static str {
    let coffee = std::env::var("STRIPE_COFFEE_PRICE_ID").unwrap_or_default();
    let pro = std::env::var("STRIPE_PRO_PRICE_ID").unwrap_or_default();
    if price_id == coffee {
        "coffee"
    } else if price_id == pro {
        "pro"
    } else {
        "free"
    }
}

pub async fn checkout(
    State(state): State<AppState>,
    Extension(auth_user): Extension<Option<AuthUser>>,
    Json(body): Json<CheckoutRequest>,
) -> Result<Json<UrlResponse>, (StatusCode, Json<ErrorResponse>)> {
    let auth_user =
        auth_user.ok_or_else(|| json_error(StatusCode::UNAUTHORIZED, "not authenticated"))?;
    let user = users::find_user_by_id(&state.pool, auth_user.id)
        .await
        .map_err(|_| json_error(StatusCode::INTERNAL_SERVER_ERROR, "database error"))?
        .ok_or_else(|| json_error(StatusCode::UNAUTHORIZED, "user not found"))?;

    let client = stripe_client()?;
    let mut params = CreateCheckoutSession::new();
    params.mode = Some(CheckoutSessionMode::Subscription);
    let success_url = format!("{}/account?checkout=success", app_url());
    let cancel_url = format!("{}/pricing", app_url());
    params.success_url = Some(success_url.as_str());
    params.cancel_url = Some(cancel_url.as_str());
    let client_reference = user.id.to_string();
    params.client_reference_id = Some(client_reference.as_str());
    params.customer_email = Some(user.email.as_str());
    params.line_items = Some(vec![CreateCheckoutSessionLineItems {
        price: Some(body.price_id),
        quantity: Some(1),
        ..Default::default()
    }]);

    let session = CheckoutSession::create(&client, params)
        .await
        .map_err(|_| json_error(StatusCode::BAD_GATEWAY, "stripe checkout failed"))?;

    let url = session
        .url
        .ok_or_else(|| json_error(StatusCode::BAD_GATEWAY, "stripe checkout url missing"))?;

    Ok(Json(UrlResponse { url }))
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
        .stripe_customer_id
        .ok_or_else(|| json_error(StatusCode::BAD_REQUEST, "no stripe customer found"))?;

    let client = stripe_client()?;
    let mut params = CreateBillingPortalSession::new(customer_id.parse().map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "invalid stripe customer id",
        )
    })?);
    let return_url = format!("{}/account", app_url());
    params.return_url = Some(return_url.as_str());

    let session = BillingPortalSession::create(&client, params)
        .await
        .map_err(|_| json_error(StatusCode::BAD_GATEWAY, "stripe portal failed"))?;

    Ok(Json(UrlResponse { url: session.url }))
}

pub async fn webhook(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: String,
) -> impl IntoResponse {
    let Ok(secret) = std::env::var("STRIPE_WEBHOOK_SECRET") else {
        return StatusCode::INTERNAL_SERVER_ERROR;
    };
    let Some(sig) = headers
        .get("stripe-signature")
        .and_then(|value| value.to_str().ok())
    else {
        return StatusCode::BAD_REQUEST;
    };

    let event = match Webhook::construct_event(&body, sig, &secret) {
        Ok(event) => event,
        Err(_) => return StatusCode::BAD_REQUEST,
    };

    if let Err(error) = handle_event(&state, event).await {
        tracing::error!("stripe webhook handler failed: {}", error);
        return StatusCode::INTERNAL_SERVER_ERROR;
    }

    StatusCode::OK
}

async fn handle_event(state: &AppState, event: Event) -> Result<(), String> {
    match event.data.object {
        EventObject::CheckoutSession(session) => {
            handle_checkout_completed(state, session).await?;
        }
        EventObject::Subscription(subscription) => {
            handle_subscription_change(state, subscription).await?;
        }
        _ => {}
    }
    Ok(())
}

async fn handle_checkout_completed(
    state: &AppState,
    session: CheckoutSession,
) -> Result<(), String> {
    let Some(reference_id) = session.client_reference_id else {
        return Ok(());
    };
    let user_id = Uuid::parse_str(&reference_id).map_err(|err| err.to_string())?;
    let Some(customer) = session.customer else {
        return Ok(());
    };
    let Some(subscription) = session.subscription else {
        return Ok(());
    };

    // fetch subscription from stripe to determine role from the actual price
    let key = std::env::var("STRIPE_SECRET_KEY")
        .map_err(|_| "missing STRIPE_SECRET_KEY".to_string())?;
    let client = StripeClient::new(key);
    let sub = stripe::Subscription::retrieve(&client, &subscription.id(), &[])
        .await
        .map_err(|err| err.to_string())?;

    let role = sub
        .items
        .data
        .first()
        .and_then(|item| item.price.as_ref())
        .map(|price| role_from_price(&price.id.to_string()))
        .unwrap_or("free");

    users::update_user_subscription(
        &state.pool,
        user_id,
        &customer.id().to_string(),
        &subscription.id().to_string(),
        role,
    )
    .await
    .map_err(|err| err.to_string())?;

    Ok(())
}

async fn handle_subscription_change(
    state: &AppState,
    subscription: stripe::Subscription,
) -> Result<(), String> {
    let customer_id = subscription.customer.id().to_string();
    let role = subscription
        .items
        .data
        .first()
        .and_then(|item| item.price.as_ref())
        .map(|price| role_from_price(&price.id.to_string()))
        .unwrap_or("free");

    let is_cancelled = matches!(
        subscription.status,
        stripe::SubscriptionStatus::Canceled
            | stripe::SubscriptionStatus::Unpaid
            | stripe::SubscriptionStatus::IncompleteExpired
    );

    let applied_role = if is_cancelled { "free" } else { role };

    users::update_role_by_customer(&state.pool, &customer_id, applied_role)
        .await
        .map_err(|err| err.to_string())?;

    Ok(())
}
