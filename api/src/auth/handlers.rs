use axum::{extract::State, http::StatusCode, response::IntoResponse, Extension, Json};
use axum_extra::extract::{
    cookie::{Cookie, SameSite},
    CookieJar,
};
use chrono::{Duration, Utc};
use cookie::time::Duration as CookieDuration;
use serde::{Deserialize, Serialize};

use crate::{
    auth::{password, tokens},
    db::users,
    models::AuthUser,
    state::AppState,
};

#[derive(Debug, Deserialize)]
pub struct RegisterRequest {
    pub email: String,
    pub password: String,
    pub display_name: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
}

#[derive(Debug, Serialize)]
pub struct UserResponse {
    pub id: String,
    pub email: String,
    pub display_name: Option<String>,
    pub role: String,
}

#[derive(Debug, Serialize)]
pub struct MeResponse {
    pub id: String,
    pub email: String,
    pub display_name: Option<String>,
    pub role: String,
    pub stripe_customer_id: Option<String>,
    pub created_at: String,
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

fn cookie_secure() -> bool {
    std::env::var("COOKIE_SECURE")
        .ok()
        .map(|v| v == "true" || v == "1")
        .unwrap_or(false)
}

fn access_ttl() -> i64 {
    std::env::var("JWT_ACCESS_EXPIRY")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(900)
}

fn refresh_ttl() -> i64 {
    std::env::var("JWT_REFRESH_EXPIRY")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(604_800)
}

fn jwt_secret() -> Result<String, (StatusCode, Json<ErrorResponse>)> {
    std::env::var("JWT_SECRET").map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "JWT_SECRET is not configured",
        )
    })
}

fn access_cookie(token: &str) -> Cookie<'static> {
    Cookie::build(("access_token", token.to_string()))
        .http_only(true)
        .same_site(SameSite::Strict)
        .secure(cookie_secure())
        .path("/")
        .max_age(CookieDuration::seconds(access_ttl()))
        .build()
}

fn refresh_cookie(token: &str) -> Cookie<'static> {
    Cookie::build(("refresh_token", token.to_string()))
        .http_only(true)
        .same_site(SameSite::Strict)
        .secure(cookie_secure())
        .path("/auth")
        .max_age(CookieDuration::seconds(refresh_ttl()))
        .build()
}

fn clear_access_cookie() -> Cookie<'static> {
    Cookie::build(("access_token", String::new()))
        .http_only(true)
        .same_site(SameSite::Strict)
        .secure(cookie_secure())
        .path("/")
        .max_age(CookieDuration::seconds(0))
        .build()
}

fn clear_refresh_cookie() -> Cookie<'static> {
    Cookie::build(("refresh_token", String::new()))
        .http_only(true)
        .same_site(SameSite::Strict)
        .secure(cookie_secure())
        .path("/auth")
        .max_age(CookieDuration::seconds(0))
        .build()
}

fn as_user_response(user: &crate::models::UserRow) -> UserResponse {
    UserResponse {
        id: user.id.to_string(),
        email: user.email.clone(),
        display_name: user.display_name.clone(),
        role: user.role.clone(),
    }
}

pub async fn register(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(body): Json<RegisterRequest>,
) -> Result<impl IntoResponse, (StatusCode, Json<ErrorResponse>)> {
    let email = body.email.trim().to_lowercase();
    if email.is_empty() || !email.contains('@') {
        return Err(json_error(StatusCode::BAD_REQUEST, "invalid email"));
    }

    if body.password.len() < 8 {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "password must be at least 8 characters",
        ));
    }

    let existing = users::find_user_by_email(&state.pool, &email)
        .await
        .map_err(|_| json_error(StatusCode::INTERNAL_SERVER_ERROR, "database error"))?;
    if existing.is_some() {
        return Err(json_error(StatusCode::CONFLICT, "email already registered"));
    }

    let password_hash = password::hash_password(&body.password)
        .map_err(|_| json_error(StatusCode::INTERNAL_SERVER_ERROR, "password hash failed"))?;

    let user = users::create_user(
        &state.pool,
        &email,
        &password_hash,
        body.display_name.as_deref(),
    )
    .await
    .map_err(|_| json_error(StatusCode::INTERNAL_SERVER_ERROR, "failed to create user"))?;

    let secret = jwt_secret()?;
    let access =
        tokens::create_access_token(user.id, &user.email, &user.role, &secret, access_ttl())
            .map_err(|_| {
                json_error(StatusCode::INTERNAL_SERVER_ERROR, "token generation failed")
            })?;

    let refresh = tokens::generate_refresh_token();
    let refresh_hash = tokens::hash_refresh_token(&refresh);
    users::store_refresh_token(
        &state.pool,
        user.id,
        &refresh_hash,
        Utc::now() + Duration::seconds(refresh_ttl()),
    )
    .await
    .map_err(|_| json_error(StatusCode::INTERNAL_SERVER_ERROR, "failed to store session"))?;

    let jar = jar
        .add(access_cookie(&access))
        .add(refresh_cookie(&refresh));

    Ok((jar, (StatusCode::CREATED, Json(as_user_response(&user)))))
}

pub async fn login(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(body): Json<LoginRequest>,
) -> Result<impl IntoResponse, (StatusCode, Json<ErrorResponse>)> {
    let email = body.email.trim().to_lowercase();
    let user = users::find_user_by_email(&state.pool, &email)
        .await
        .map_err(|_| json_error(StatusCode::INTERNAL_SERVER_ERROR, "database error"))?
        .ok_or_else(|| json_error(StatusCode::UNAUTHORIZED, "invalid credentials"))?;

    if !password::verify_password(&body.password, &user.password_hash) {
        return Err(json_error(StatusCode::UNAUTHORIZED, "invalid credentials"));
    }

    let secret = jwt_secret()?;
    let access =
        tokens::create_access_token(user.id, &user.email, &user.role, &secret, access_ttl())
            .map_err(|_| {
                json_error(StatusCode::INTERNAL_SERVER_ERROR, "token generation failed")
            })?;

    let refresh = tokens::generate_refresh_token();
    let refresh_hash = tokens::hash_refresh_token(&refresh);
    users::store_refresh_token(
        &state.pool,
        user.id,
        &refresh_hash,
        Utc::now() + Duration::seconds(refresh_ttl()),
    )
    .await
    .map_err(|_| json_error(StatusCode::INTERNAL_SERVER_ERROR, "failed to store session"))?;

    let jar = jar
        .add(access_cookie(&access))
        .add(refresh_cookie(&refresh));

    Ok((jar, Json(as_user_response(&user))))
}

pub async fn refresh(
    State(state): State<AppState>,
    jar: CookieJar,
) -> Result<impl IntoResponse, (StatusCode, Json<ErrorResponse>)> {
    let raw_refresh = jar
        .get("refresh_token")
        .ok_or_else(|| json_error(StatusCode::UNAUTHORIZED, "missing refresh token"))?
        .value()
        .to_string();

    let refresh_hash = tokens::hash_refresh_token(&raw_refresh);
    let stored = users::find_refresh_token(&state.pool, &refresh_hash)
        .await
        .map_err(|_| json_error(StatusCode::INTERNAL_SERVER_ERROR, "database error"))?
        .ok_or_else(|| json_error(StatusCode::UNAUTHORIZED, "invalid refresh token"))?;

    if stored.expires_at < Utc::now() {
        let _ = users::delete_refresh_token(&state.pool, &refresh_hash).await;
        return Err(json_error(
            StatusCode::UNAUTHORIZED,
            "refresh token expired",
        ));
    }

    let user = users::find_user_by_id(&state.pool, stored.user_id)
        .await
        .map_err(|_| json_error(StatusCode::INTERNAL_SERVER_ERROR, "database error"))?
        .ok_or_else(|| json_error(StatusCode::UNAUTHORIZED, "user not found"))?;

    users::delete_refresh_token(&state.pool, &refresh_hash)
        .await
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "refresh token rotation failed",
            )
        })?;

    let secret = jwt_secret()?;
    let new_access =
        tokens::create_access_token(user.id, &user.email, &user.role, &secret, access_ttl())
            .map_err(|_| {
                json_error(StatusCode::INTERNAL_SERVER_ERROR, "token generation failed")
            })?;
    let new_refresh = tokens::generate_refresh_token();
    let new_refresh_hash = tokens::hash_refresh_token(&new_refresh);

    users::store_refresh_token(
        &state.pool,
        user.id,
        &new_refresh_hash,
        Utc::now() + Duration::seconds(refresh_ttl()),
    )
    .await
    .map_err(|_| json_error(StatusCode::INTERNAL_SERVER_ERROR, "failed to store session"))?;

    let jar = jar
        .add(access_cookie(&new_access))
        .add(refresh_cookie(&new_refresh));
    Ok((jar, Json(as_user_response(&user))))
}

pub async fn logout(
    State(state): State<AppState>,
    jar: CookieJar,
    Extension(auth_user): Extension<Option<AuthUser>>,
) -> Result<impl IntoResponse, (StatusCode, Json<ErrorResponse>)> {
    let auth_user =
        auth_user.ok_or_else(|| json_error(StatusCode::UNAUTHORIZED, "not authenticated"))?;

    users::delete_all_refresh_tokens(&state.pool, auth_user.id)
        .await
        .map_err(|_| json_error(StatusCode::INTERNAL_SERVER_ERROR, "logout failed"))?;

    let jar = jar.add(clear_access_cookie()).add(clear_refresh_cookie());
    Ok((jar, StatusCode::OK))
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

    Ok(Json(MeResponse {
        id: user.id.to_string(),
        email: user.email,
        display_name: user.display_name,
        role: user.role,
        stripe_customer_id: user.stripe_customer_id,
        created_at: user.created_at.to_rfc3339(),
    }))
}
