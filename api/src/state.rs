use sqlx::PgPool;

use crate::schema::AppSchema;

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub schema: AppSchema,
}
