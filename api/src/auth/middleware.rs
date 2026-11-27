use axum::{
    extract::{Request, State},
    http::header,
    middleware::Next,
    response::Response,
};
use axum_extra::extract::CookieJar;
use std::{
    collections::HashMap,
    future::Future,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

use crate::{auth::clerk, state::AppState};

// the dashboard sends a bearer token; clerk-js also keeps a __session cookie
// on the app origin, which covers plain browser requests
const REJECTION_LOG_INTERVAL: Duration = Duration::from_secs(60);

#[derive(Clone, Copy, Eq, Hash, PartialEq)]
enum SessionTokenSource {
    Bearer,
    Cookie,
}

impl SessionTokenSource {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Bearer => "bearer",
            Self::Cookie => "cookie",
        }
    }
}

struct SessionToken {
    source: SessionTokenSource,
    value: String,
}

#[derive(Eq, Hash, PartialEq)]
struct RejectionLogKey {
    source: SessionTokenSource,
    stage: &'static str,
    kind: &'static str,
}

struct RejectionLogLimiter {
    last_logged: HashMap<RejectionLogKey, Instant>,
    interval: Duration,
}

impl RejectionLogLimiter {
    fn new(interval: Duration) -> Self {
        Self {
            last_logged: HashMap::new(),
            interval,
        }
    }

    fn should_log(
        &mut self,
        source: SessionTokenSource,
        error: clerk::VerificationError,
        now: Instant,
    ) -> bool {
        let key = RejectionLogKey {
            source,
            stage: error.stage(),
            kind: error.kind(),
        };
        if self
            .last_logged
            .get(&key)
            .is_some_and(|last| now.duration_since(*last) < self.interval)
        {
            return false;
        }
        self.last_logged.insert(key, now);
        true
    }
}

fn should_log_rejection(source: SessionTokenSource, error: clerk::VerificationError) -> bool {
    static LIMITER: OnceLock<Mutex<RejectionLogLimiter>> = OnceLock::new();
    let limiter =
        LIMITER.get_or_init(|| Mutex::new(RejectionLogLimiter::new(REJECTION_LOG_INTERVAL)));
    limiter
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .should_log(source, error, Instant::now())
}

fn session_tokens(req: &Request, jar: &CookieJar) -> Vec<SessionToken> {
    let bearer = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let cookie = jar
        .get("__session")
        .map(|cookie| cookie.value().to_string())
        .filter(|value| !value.is_empty());

    let mut tokens = Vec::with_capacity(2);
    if let Some(value) = bearer.as_ref() {
        tokens.push(SessionToken {
            source: SessionTokenSource::Bearer,
            value: value.clone(),
        });
    }
    if let Some(value) = cookie {
        if bearer.as_deref() != Some(value.as_str()) {
            tokens.push(SessionToken {
                source: SessionTokenSource::Cookie,
                value,
            });
        }
    }
    tokens
}

async fn first_verified<T, F, Fut>(tokens: Vec<SessionToken>, mut verify: F) -> Option<T>
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = Result<T, clerk::VerificationError>>,
{
    for token in tokens {
        match verify(token.value).await {
            Ok(value) => return Some(value),
            Err(error) => {
                if should_log_rejection(token.source, error) {
                    tracing::warn!(
                        source = token.source.as_str(),
                        stage = error.stage(),
                        kind = error.kind(),
                        "clerk session token rejected"
                    );
                }
            }
        }
    }
    None
}

pub async fn auth_middleware(
    State(state): State<AppState>,
    jar: CookieJar,
    mut req: Request,
    next: Next,
) -> Response {
    let mut auth_user = None;
    if let Some(claims) = first_verified(session_tokens(&req, &jar), |token| async move {
        clerk::verify_session_token(&token).await
    })
    .await
    {
        auth_user = clerk::resolve_user(&state.pool, &claims).await;
    }

    req.extensions_mut().insert(auth_user);
    next.run(req).await
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use axum::body::Body;
    use axum_extra::extract::cookie::Cookie;

    use super::*;

    fn request_with_bearer(value: &str) -> Request {
        Request::builder()
            .header(header::AUTHORIZATION, format!("Bearer {value}"))
            .body(Body::empty())
            .expect("request")
    }

    #[tokio::test]
    async fn falls_back_to_cookie_after_rejected_bearer() {
        let request = request_with_bearer("rejected-bearer");
        let jar = CookieJar::new().add(Cookie::new("__session", "valid-cookie"));
        let attempts = Arc::new(Mutex::new(Vec::new()));
        let captured_attempts = Arc::clone(&attempts);

        let verified = first_verified(session_tokens(&request, &jar), move |token| {
            let attempts = Arc::clone(&captured_attempts);
            async move {
                attempts.lock().expect("attempt lock").push(token.clone());
                if token == "valid-cookie" {
                    Ok("verified")
                } else {
                    Err(clerk::VerificationError::rejected_token_for_test())
                }
            }
        })
        .await;

        assert_eq!(verified, Some("verified"));
        assert_eq!(
            *attempts.lock().expect("attempt lock"),
            ["rejected-bearer", "valid-cookie"]
        );
    }

    #[test]
    fn does_not_verify_the_same_token_twice() {
        let request = request_with_bearer("same-token");
        let jar = CookieJar::new().add(Cookie::new("__session", "same-token"));

        let tokens = session_tokens(&request, &jar);

        assert_eq!(tokens.len(), 1);
        assert_eq!(tokens[0].source.as_str(), "bearer");
        assert_eq!(tokens[0].value, "same-token");
    }

    #[test]
    fn ignores_an_empty_bearer_and_keeps_the_cookie() {
        let request = request_with_bearer("   ");
        let jar = CookieJar::new().add(Cookie::new("__session", "cookie-token"));

        let tokens = session_tokens(&request, &jar);

        assert_eq!(tokens.len(), 1);
        assert_eq!(tokens[0].source.as_str(), "cookie");
        assert_eq!(tokens[0].value, "cookie-token");
    }

    #[test]
    fn bounds_rejection_logs_by_source_stage_and_kind() {
        let mut limiter = RejectionLogLimiter::new(REJECTION_LOG_INTERVAL);
        let start = Instant::now();
        let rejection = clerk::VerificationError::rejected_token_for_test();

        assert!(limiter.should_log(SessionTokenSource::Bearer, rejection, start));
        assert!(!limiter.should_log(
            SessionTokenSource::Bearer,
            rejection,
            start + Duration::from_secs(59)
        ));
        assert!(limiter.should_log(SessionTokenSource::Cookie, rejection, start));
        assert!(limiter.should_log(
            SessionTokenSource::Bearer,
            rejection,
            start + REJECTION_LOG_INTERVAL
        ));
    }
}
