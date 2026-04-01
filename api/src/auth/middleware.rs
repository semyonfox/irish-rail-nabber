use axum::{extract::Request, middleware::Next, response::Response};
use axum_extra::extract::CookieJar;

use crate::auth::tokens;
use crate::models::AuthUser;

pub async fn auth_middleware(jar: CookieJar, mut req: Request, next: Next) -> Response {
    let auth_user = jar.get("access_token").and_then(|cookie| {
        let Ok(secret) = std::env::var("JWT_SECRET") else {
            return None;
        };

        tokens::verify_access_token(cookie.value(), &secret)
            .ok()
            .map(|claims| AuthUser {
                id: claims.sub,
                email: claims.email,
                role: claims.role,
            })
    });

    req.extensions_mut().insert(auth_user);
    next.run(req).await
}
