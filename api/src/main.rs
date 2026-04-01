mod auth;
mod billing;
mod db;
mod models;
mod schema;
mod state;

use async_graphql::http::{playground_source, GraphQLPlaygroundConfig};
use async_graphql_axum::{GraphQLRequest, GraphQLResponse};
use axum::{
    extract::State,
    http::{header, Method, StatusCode},
    middleware as axum_middleware,
    response::{Html, IntoResponse},
    routing::{get, post},
    Extension, Router,
};
use tower_http::cors::CorsLayer;

use models::AuthUser;
use state::AppState;

async fn graphql_handler(
    State(state): State<AppState>,
    Extension(auth_user): Extension<Option<AuthUser>>,
    req: GraphQLRequest,
) -> GraphQLResponse {
    state
        .schema
        .execute(req.into_inner().data(auth_user))
        .await
        .into()
}

async fn graphql_playground() -> impl IntoResponse {
    Html(playground_source(GraphQLPlaygroundConfig::new("/graphql")))
}

async fn health() -> impl IntoResponse {
    (StatusCode::OK, "ok")
}

#[tokio::main]
async fn main() {
    // try .env.local first (local overrides), then .env
    dotenvy::from_filename(".env.local").ok();
    dotenvy::dotenv().ok();

    tracing_subscriber::fmt()
        .with_env_filter("irish_rail_api=info")
        .init();

    let pool = db::create_pool().await;
    tracing::info!("connected to database");

    let schema = schema::build_schema(pool.clone());
    let app_state = AppState { pool, schema };

    let cors_origins = std::env::var("CORS_ORIGINS")
        .unwrap_or_else(|_| "http://localhost:3000,http://localhost:5173".to_string());
    let origins: Vec<_> = cors_origins
        .split(',')
        .filter_map(|origin| origin.trim().parse().ok())
        .collect();

    let cors = CorsLayer::new()
        .allow_origin(origins)
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION, header::COOKIE])
        .allow_credentials(true);

    let auth_routes = Router::new()
        .route("/register", post(auth::handlers::register))
        .route("/login", post(auth::handlers::login))
        .route("/refresh", post(auth::handlers::refresh))
        .route("/logout", post(auth::handlers::logout))
        .route("/me", get(auth::handlers::me));

    let billing_routes = Router::new()
        .route("/checkout", post(billing::handlers::checkout))
        .route("/portal", post(billing::handlers::portal));

    let app = Router::new()
        .route("/graphql", get(graphql_playground).post(graphql_handler))
        .nest("/auth", auth_routes)
        .nest("/billing", billing_routes)
        .route("/billing/webhook", post(billing::handlers::webhook))
        .route("/health", get(health))
        .layer(axum_middleware::from_fn(auth::middleware::auth_middleware))
        .layer(cors)
        .with_state(app_state);

    let addr = "0.0.0.0:8000";
    tracing::info!("listening on {}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
