pub mod analytics;
pub(crate) mod bounds;
pub mod bus;
pub mod bus_history;
pub mod bus_published;
pub mod station;
pub mod train;
pub mod types;

use async_graphql::{MergedObject, Schema};
use sqlx::PgPool;

use crate::state::QueryCache;
use analytics::AnalyticsQuery;
use bus::BusQuery;
use bus_history::BusHistoryQuery;
use bus_published::BusPublishedQuery;
use station::StationQuery;
use train::TrainQuery;

/// absolute cutoff for the rail hypertables, whose `fetched_at` is a UTC
/// `TIMESTAMP`. a bound value lets TimescaleDB exclude chunks before execution,
/// which `NOW() - interval` can't. callers run with `.persistent(false)`
/// because a cached generic plan doesn't know the value and scans every chunk
pub(crate) fn rail_cutoff(window: chrono::Duration) -> chrono::NaiveDateTime {
    chrono::Utc::now().naive_utc() - window
}

const MAX_QUERY_COMPLEXITY: usize = 1_000;
const MAX_QUERY_DEPTH: usize = 12;

#[derive(MergedObject, Default)]
pub struct Query(
    StationQuery,
    TrainQuery,
    AnalyticsQuery,
    BusQuery,
    BusHistoryQuery,
    BusPublishedQuery,
);

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
