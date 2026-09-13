use axum::{
    extract::{Request, State},
    http::header,
    middleware::Next,
    response::Response,
};
use axum_extra::extract::CookieJar;

use crate::{auth::clerk, state::AppState};

// the dashboard sends a bearer token; clerk-js also keeps a __session cookie
// on the app origin, which covers plain browser requests
fn session_token(req: &Request, jar: &CookieJar) -> Option<String> {
    req.headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            jar.get("__session")
                .map(|cookie| cookie.value().to_string())
        })
}

pub async fn auth_middleware(
    State(state): State<AppState>,
    jar: CookieJar,
    mut req: Request,
    next: Next,
) -> Response {
    let mut auth_user = None;
    if let Some(token) = session_token(&req, &jar) {
        if let Some(claims) = clerk::verify_session_token(&token).await {
            auth_user = clerk::resolve_user(&state.pool, &claims).await;
        }
    }

    req.extensions_mut().insert(auth_user);
    next.run(req).await
}
