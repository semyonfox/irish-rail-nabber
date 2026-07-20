use std::{sync::Arc, time::Duration};

use moka::future::Cache;
use sqlx::PgPool;

use crate::schema::types::{
    DelayHistoryPoint, NetworkSummary, RouteReliability, StationDelayStats,
};
use crate::schema::AppSchema;

#[derive(Clone)]
pub struct QueryCache {
    pub delay_history: Cache<String, Arc<Vec<DelayHistoryPoint>>>,
    pub station_delay_stats: Cache<String, Arc<Vec<StationDelayStats>>>,
    pub network_summary: Cache<(), Arc<NetworkSummary>>,
    pub route_reliability: Cache<String, Arc<Vec<RouteReliability>>>,
}

impl QueryCache {
    pub fn new() -> Self {
        Self {
            delay_history: cache(Duration::from_secs(300), 256),
            station_delay_stats: cache(Duration::from_secs(60), 32),
            network_summary: cache(Duration::from_secs(10), 1),
            route_reliability: cache(Duration::from_secs(60), 32),
        }
    }
}

fn cache<K, V>(ttl: Duration, capacity: u64) -> Cache<K, Arc<V>>
where
    K: std::hash::Hash + Eq + Send + Sync + 'static,
    V: Send + Sync + 'static,
{
    Cache::builder()
        .time_to_live(ttl)
        .max_capacity(capacity)
        .build()
}

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub schema: AppSchema,
}
