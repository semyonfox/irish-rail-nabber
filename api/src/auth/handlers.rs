use axum::{extract::State, http::StatusCode, Extension, Json};
use serde::Serialize;

use crate::{
    db::users,
    models::{AuthUser, UserRow},
    state::AppState,
};

// sign-in, sign-up and sessions live in clerk; these endpoints only expose the
// app-side account (plan role, billing) for the signed-in clerk user

#[derive(Debug, Serialize)]
pub struct MeResponse {
    pub id: String,
    pub email: String,
    pub display_name: Option<String>,
    pub role: String,
    pub can_manage_billing: bool,
    pub created_at: String,
}

#[derive(Debug, Serialize)]
pub struct SessionResponse {
    pub user: Option<MeResponse>,
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

fn as_me(user: UserRow) -> MeResponse {
    MeResponse {
        id: user.id.to_string(),
        email: user.email,
        display_name: user.display_name,
        role: user.role,
        can_manage_billing: user.polar_customer_id.is_some(),
        created_at: user.created_at.to_rfc3339(),
    }
}

#[derive(Debug, Serialize)]
pub struct ConfigResponse {
    pub clerk_publishable_key: Option<String>,
    pub billing_enabled: bool,
}

// the publishable key is public; serving it at runtime keeps it out of the
// dashboard build, whose docker context ignores .env files
pub async fn config() -> Json<ConfigResponse> {
    Json(ConfigResponse {
        clerk_publishable_key: std::env::var("CLERK_PUBLISHABLE_KEY")
            .ok()
            .filter(|key| key.starts_with("pk_")),
        billing_enabled: crate::billing::handlers::billing_enabled(),
    })
}

pub async fn me(
    State(state): State<AppState>,
    Extension(auth_user): Extension<Option<AuthUser>>,
) -> Result<Json<MeResponse>, (StatusCode, Json<ErrorResponse>)> {
    let auth_user =
        auth_user.ok_or_else(|| json_error(StatusCode::UNAUTHORIZED, "not authenticated"))?;

    let user = users::find_user_by_id(&state.pool, auth_user.id)
        .await
        .map_err(|_| json_error(StatusCode::INTERNAL_SERVER_ERROR, "database error"))?
        .ok_or_else(|| json_error(StatusCode::UNAUTHORIZED, "user not found"))?;

    Ok(Json(as_me(user)))
}

pub async fn session(
    State(state): State<AppState>,
    Extension(auth_user): Extension<Option<AuthUser>>,
) -> Result<Json<SessionResponse>, (StatusCode, Json<ErrorResponse>)> {
    let Some(auth_user) = auth_user else {
        return Ok(Json(SessionResponse { user: None }));
    };

    let user = users::find_user_by_id(&state.pool, auth_user.id)
        .await
        .map_err(|_| json_error(StatusCode::INTERNAL_SERVER_ERROR, "database error"))?;

    Ok(Json(SessionResponse {
        user: user.map(as_me),
    }))
}
