use std::{sync::Arc, time::Duration};

use moka::future::Cache;
use sqlx::PgPool;

use crate::schema::types::{
    BusDeparture, BusRouteDelay, BusStop, BusVehicle, DelayHistoryPoint, NetworkSummary,
    RouteReliability, StationDelayStats,
};
use crate::schema::AppSchema;

#[derive(Clone)]
pub struct QueryCache {
    pub delay_history: Cache<String, Arc<Vec<DelayHistoryPoint>>>,
    pub station_delay_stats: Cache<String, Arc<Vec<StationDelayStats>>>,
    pub network_summary: Cache<(), Arc<NetworkSummary>>,
    pub route_reliability: Cache<String, Arc<Vec<RouteReliability>>>,
    pub bus_stops: Cache<String, Arc<Vec<BusStop>>>,
    pub bus_stop_boards: Cache<String, Arc<Vec<BusDeparture>>>,
    pub bus_route_delays: Cache<String, Arc<Vec<BusRouteDelay>>>,
    pub bus_vehicles: Cache<String, Arc<Vec<BusVehicle>>>,
}

impl QueryCache {
    pub fn new() -> Self {
        Self {
            delay_history: cache(Duration::from_secs(300), 256),
            station_delay_stats: cache(Duration::from_secs(60), 32),
            network_summary: cache(Duration::from_secs(10), 1),
            route_reliability: cache(Duration::from_secs(60), 32),
            bus_stops: cache(Duration::from_secs(900), 256),
            bus_stop_boards: cache(Duration::from_secs(20), 1_024),
            bus_route_delays: cache(Duration::from_secs(60), 128),
            bus_vehicles: cache(Duration::from_secs(30), 128),
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
