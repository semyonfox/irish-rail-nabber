pub mod analytics;
pub(crate) mod bounds;
pub mod bus;
pub mod station;
pub mod train;
pub mod types;

use async_graphql::{MergedObject, Schema};
use sqlx::PgPool;

use crate::state::QueryCache;
use analytics::AnalyticsQuery;
use bus::BusQuery;
use station::StationQuery;
use train::TrainQuery;

const MAX_QUERY_COMPLEXITY: usize = 1_000;
const MAX_QUERY_DEPTH: usize = 12;

#[derive(MergedObject, Default)]
pub struct Query(StationQuery, TrainQuery, AnalyticsQuery, BusQuery);

pub type AppSchema = Schema<Query, async_graphql::EmptyMutation, async_graphql::EmptySubscription>;

pub fn build_schema(pool: PgPool, cache: QueryCache) -> AppSchema {
    Schema::build(
        Query::default(),
        async_graphql::EmptyMutation,
        async_graphql::EmptySubscription,
    )
    .limit_complexity(MAX_QUERY_COMPLEXITY)
    .limit_depth(MAX_QUERY_DEPTH)
    .data(pool)
    .data(cache)
    .finish()
}
