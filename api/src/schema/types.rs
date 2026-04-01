use async_graphql::SimpleObject;
use bigdecimal::BigDecimal;
use chrono::{NaiveDate, NaiveDateTime, NaiveTime};

use crate::models::*;

// helper to convert BigDecimal to f64 for graphql
fn bd_to_f64(bd: &Option<BigDecimal>) -> Option<f64> {
    bd.as_ref().and_then(|v| {
        use bigdecimal::ToPrimitive;
        v.to_f64()
    })
}

fn time_to_string(t: &Option<NaiveTime>) -> Option<String> {
    t.map(|t| t.format("%H:%M:%S").to_string())
}

fn datetime_to_string(dt: &Option<NaiveDateTime>) -> Option<String> {
    dt.map(|dt| dt.format("%Y-%m-%dT%H:%M:%S").to_string())
}

fn date_to_string(d: &Option<NaiveDate>) -> Option<String> {
    d.map(|d| d.format("%Y-%m-%d").to_string())
}

#[derive(SimpleObject)]
pub struct Station {
    pub station_code: String,
    pub station_desc: String,
    pub station_type: Option<String>,
    pub is_dart: Option<bool>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
}

impl From<StationRow> for Station {
    fn from(r: StationRow) -> Self {
        Self {
            station_code: r.station_code,
            station_desc: r.station_desc,
            station_type: r.station_type,
            is_dart: r.is_dart,
            latitude: bd_to_f64(&r.latitude),
            longitude: bd_to_f64(&r.longitude),
        }
    }
}

#[derive(SimpleObject)]
pub struct TrainPosition {
    pub train_code: String,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub train_status: Option<String>,
    pub direction: Option<String>,
    pub fetched_at: Option<String>,
}

impl From<TrainPositionRow> for TrainPosition {
    fn from(r: TrainPositionRow) -> Self {
        Self {
            train_code: r.train_code,
            latitude: bd_to_f64(&r.latitude),
            longitude: bd_to_f64(&r.longitude),
            train_status: r.train_status,
            direction: r.direction,
            fetched_at: datetime_to_string(&r.fetched_at),
        }
    }
}

#[derive(SimpleObject)]
pub struct StationEvent {
    pub train_code: String,
    pub station_code: Option<String>,
    pub train_date: Option<String>,
    pub origin: Option<String>,
    pub destination: Option<String>,
    pub train_type: Option<String>,
    pub direction: Option<String>,
    pub status: Option<String>,
    pub scheduled_arrival: Option<String>,
    pub scheduled_departure: Option<String>,
    pub expected_arrival: Option<String>,
    pub expected_departure: Option<String>,
    pub late_minutes: Option<i32>,
    pub last_location: Option<String>,
    pub due_in: Option<i32>,
    pub fetched_at: String,
}

impl From<StationEventRow> for StationEvent {
    fn from(r: StationEventRow) -> Self {
        Self {
            train_code: r.train_code,
            station_code: r.station_code,
            train_date: date_to_string(&r.train_date),
            origin: r.origin,
            destination: r.destination,
            train_type: r.train_type,
            direction: r.direction,
            status: r.status,
            scheduled_arrival: time_to_string(&r.scheduled_arrival),
            scheduled_departure: time_to_string(&r.scheduled_departure),
            expected_arrival: time_to_string(&r.expected_arrival),
            expected_departure: time_to_string(&r.expected_departure),
            late_minutes: r.late_minutes,
            last_location: r.last_location,
            due_in: r.due_in,
            fetched_at: r.fetched_at.format("%Y-%m-%dT%H:%M:%S").to_string(),
        }
    }
}

#[derive(SimpleObject)]
pub struct TrainMovement {
    pub train_code: String,
    pub train_date: String,
    pub location_code: Option<String>,
    pub location_full_name: Option<String>,
    pub location_order: i32,
    pub location_type: Option<String>,
    pub train_origin: Option<String>,
    pub train_destination: Option<String>,
    pub scheduled_arrival: Option<String>,
    pub scheduled_departure: Option<String>,
    pub expected_arrival: Option<String>,
    pub expected_departure: Option<String>,
    pub actual_arrival: Option<String>,
    pub actual_departure: Option<String>,
    pub stop_type: Option<String>,
    pub fetched_at: String,
}

impl From<TrainMovementRow> for TrainMovement {
    fn from(r: TrainMovementRow) -> Self {
        Self {
            train_code: r.train_code,
            train_date: r.train_date.format("%Y-%m-%d").to_string(),
            location_code: r.location_code,
            location_full_name: r.location_full_name,
            location_order: r.location_order,
            location_type: r.location_type,
            train_origin: r.train_origin,
            train_destination: r.train_destination,
            scheduled_arrival: time_to_string(&r.scheduled_arrival),
            scheduled_departure: time_to_string(&r.scheduled_departure),
            expected_arrival: time_to_string(&r.expected_arrival),
            expected_departure: time_to_string(&r.expected_departure),
            actual_arrival: time_to_string(&r.actual_arrival),
            actual_departure: time_to_string(&r.actual_departure),
            stop_type: r.stop_type,
            fetched_at: r.fetched_at.format("%Y-%m-%dT%H:%M:%S").to_string(),
        }
    }
}

#[derive(SimpleObject)]
pub struct HourlyDelay {
    pub hour: String,
    pub station_code: Option<String>,
    pub avg_late_minutes: Option<f64>,
    pub max_late_minutes: Option<i32>,
    pub event_count: Option<i64>,
}

impl From<HourlyDelayRow> for HourlyDelay {
    fn from(r: HourlyDelayRow) -> Self {
        Self {
            hour: r.hour.format("%Y-%m-%dT%H:%M:%S").to_string(),
            station_code: r.station_code,
            avg_late_minutes: bd_to_f64(&r.avg_late_minutes),
            max_late_minutes: r.max_late_minutes,
            event_count: r.event_count,
        }
    }
}

#[derive(SimpleObject)]
pub struct StationDelayStats {
    pub station_code: String,
    pub station_desc: String,
    pub avg_late_minutes: f64,
    pub max_late_minutes: i32,
    pub on_time_pct: f64,
    pub total_events: i64,
}

#[derive(SimpleObject)]
pub struct NetworkSummary {
    pub active_trains: i64,
    pub total_stations: i64,
    pub avg_delay_minutes: f64,
    pub on_time_pct: f64,
    pub last_updated: Option<String>,
}

#[derive(SimpleObject)]
pub struct RouteReliability {
    pub origin: String,
    pub destination: String,
    pub avg_late_minutes: f64,
    pub on_time_pct: f64,
    pub train_count: i64,
}

#[derive(SimpleObject)]
pub struct FetchStatus {
    pub endpoint: Option<String>,
    pub last_status: Option<String>,
    pub last_record_count: Option<i32>,
    pub last_duration_ms: Option<i32>,
    pub last_fetched: String,
}

impl From<crate::models::FetchHistoryRow> for FetchStatus {
    fn from(r: crate::models::FetchHistoryRow) -> Self {
        Self {
            endpoint: r.endpoint,
            last_status: r.status,
            last_record_count: r.record_count,
            last_duration_ms: r.duration_ms,
            last_fetched: r.fetched_at.format("%Y-%m-%dT%H:%M:%S").to_string(),
        }
    }
}
