pub mod types;
pub mod station;
pub mod train;
pub mod analytics;

use async_graphql::{MergedObject, Schema};
use sqlx::PgPool;

use station::StationQuery;
use train::TrainQuery;
use analytics::AnalyticsQuery;

#[derive(MergedObject, Default)]
pub struct Query(StationQuery, TrainQuery, AnalyticsQuery);

pub type AppSchema = Schema<Query, async_graphql::EmptyMutation, async_graphql::EmptySubscription>;

pub fn build_schema(pool: PgPool) -> AppSchema {
    Schema::build(Query::default(), async_graphql::EmptyMutation, async_graphql::EmptySubscription)
        .data(pool)
        .finish()
}
