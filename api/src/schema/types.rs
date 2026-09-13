use async_graphql::SimpleObject;
use bigdecimal::BigDecimal;
use chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, SecondsFormat, Utc};

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

fn utc_datetime_to_string(dt: &Option<DateTime<Utc>>) -> Option<String> {
    dt.as_ref()
        .map(|value| value.to_rfc3339_opts(SecondsFormat::Secs, true))
}

fn required_utc_datetime_to_string(dt: &DateTime<Utc>) -> String {
    dt.to_rfc3339_opts(SecondsFormat::Secs, true)
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

#[derive(Clone, SimpleObject)]
pub struct BusStop {
    pub stop_id: String,
    pub stop_code: Option<String>,
    pub stop_name: Option<String>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
}

impl From<BusStopRow> for BusStop {
    fn from(row: BusStopRow) -> Self {
        Self {
            stop_id: row.stop_id,
            stop_code: row.stop_code,
            stop_name: row.stop_name,
            latitude: row.latitude,
            longitude: row.longitude,
        }
    }
}

#[derive(Clone, SimpleObject)]
pub struct BusDeparture {
    pub entity_id: Option<String>,
    pub trip_id: Option<String>,
    pub route_id: Option<String>,
    pub route_short_name: Option<String>,
    pub route_long_name: Option<String>,
    pub operator_name: Option<String>,
    pub headsign: Option<String>,
    pub service_date: Option<String>,
    pub scheduled_time: Option<String>,
    pub expected_time: Option<String>,
    pub delay_seconds: Option<i32>,
    pub schedule_relationship: Option<String>,
    pub fetched_at: String,
}

impl From<BusDepartureRow> for BusDeparture {
    fn from(row: BusDepartureRow) -> Self {
        Self {
            entity_id: row.entity_id,
            trip_id: row.trip_id,
            route_id: row.route_id,
            route_short_name: row.route_short_name,
            route_long_name: row.route_long_name,
            operator_name: row.operator_name,
            headsign: row.headsign,
            service_date: date_to_string(&row.service_date),
            scheduled_time: utc_datetime_to_string(&row.scheduled_time),
            expected_time: utc_datetime_to_string(&row.expected_time),
            delay_seconds: row.delay_seconds,
            schedule_relationship: row.schedule_relationship,
            fetched_at: required_utc_datetime_to_string(&row.fetched_at),
        }
    }
}

#[derive(Clone, SimpleObject)]
pub struct BusRouteDelay {
    pub route_id: String,
    pub route_short_name: Option<String>,
    pub route_long_name: Option<String>,
    pub operator_name: Option<String>,
    pub avg_delay_seconds: f64,
    pub on_time_pct: f64,
    pub sample_count: i64,
    pub last_updated: String,
}

#[derive(Clone, SimpleObject)]
pub struct BusVehicle {
    pub entity_id: Option<String>,
    pub vehicle_id: Option<String>,
    pub vehicle_label: Option<String>,
    pub trip_id: Option<String>,
    pub route_id: Option<String>,
    pub route_short_name: Option<String>,
    pub route_long_name: Option<String>,
    pub operator_name: Option<String>,
    pub headsign: Option<String>,
    pub latitude: f64,
    pub longitude: f64,
    pub bearing: Option<f64>,
    pub speed_meters_per_second: Option<f64>,
    pub current_stop_sequence: Option<i32>,
    pub stop_id: Option<String>,
    pub current_status: Option<String>,
    pub occupancy_status: Option<String>,
    pub source_timestamp: Option<String>,
    pub fetched_at: String,
}

impl From<BusVehicleRow> for BusVehicle {
    fn from(row: BusVehicleRow) -> Self {
        Self {
            entity_id: row.entity_id,
            vehicle_id: row.vehicle_id,
            vehicle_label: row.vehicle_label,
            trip_id: row.trip_id,
            route_id: row.route_id,
            route_short_name: row.route_short_name,
            route_long_name: row.route_long_name,
            operator_name: row.operator_name,
            headsign: row.headsign,
            latitude: row.latitude,
            longitude: row.longitude,
            bearing: row.bearing,
            speed_meters_per_second: row.speed_meters_per_second,
            current_stop_sequence: row.current_stop_sequence,
            stop_id: row.stop_id,
            current_status: row.current_status,
            occupancy_status: row.occupancy_status,
            source_timestamp: utc_datetime_to_string(&row.source_timestamp),
            fetched_at: required_utc_datetime_to_string(&row.fetched_at),
        }
    }
}

impl From<BusRouteDelayRow> for BusRouteDelay {
    fn from(row: BusRouteDelayRow) -> Self {
        Self {
            route_id: row.route_id,
            route_short_name: row.route_short_name,
            route_long_name: row.route_long_name,
            operator_name: row.operator_name,
            avg_delay_seconds: row.avg_delay_seconds,
            on_time_pct: row.on_time_pct,
            sample_count: row.sample_count,
            last_updated: required_utc_datetime_to_string(&row.last_updated),
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
    pub train_type: Option<String>,
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
            train_type: r.train_type,
            fetched_at: datetime_to_string(&r.fetched_at),
        }
    }
}

#[derive(SimpleObject)]
pub struct RouteSegment {
    pub from_station_code: String,
    pub from_station_name: String,
    pub from_latitude: Option<f64>,
    pub from_longitude: Option<f64>,
    pub to_station_code: String,
    pub to_station_name: String,
    pub to_latitude: Option<f64>,
    pub to_longitude: Option<f64>,
    pub train_count: i64,
    pub last_seen: Option<String>,
}

impl From<RouteSegmentRow> for RouteSegment {
    fn from(r: RouteSegmentRow) -> Self {
        Self {
            from_station_code: r.from_station_code,
            from_station_name: r.from_station_name,
            from_latitude: bd_to_f64(&r.from_latitude),
            from_longitude: bd_to_f64(&r.from_longitude),
            to_station_code: r.to_station_code,
            to_station_name: r.to_station_name,
            to_latitude: bd_to_f64(&r.to_latitude),
            to_longitude: bd_to_f64(&r.to_longitude),
            train_count: r.train_count,
            last_seen: datetime_to_string(&r.last_seen),
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
pub struct CountryBoardEvent {
    pub train_code: String,
    pub station_code: String,
    pub station_desc: String,
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

impl From<CountryBoardEventRow> for CountryBoardEvent {
    fn from(r: CountryBoardEventRow) -> Self {
        Self {
            train_code: r.train_code,
            station_code: r.station_code,
            station_desc: r.station_desc,
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

#[derive(Clone, SimpleObject)]
pub struct DelayHistoryPoint {
    pub bucket: String,
    pub avg_late_minutes: f64,
    pub p95_late_minutes: f64,
    pub max_late_minutes: i32,
    pub on_time_pct: f64,
    pub event_count: i64,
}

impl From<DelayHistoryRow> for DelayHistoryPoint {
    fn from(r: DelayHistoryRow) -> Self {
        Self {
            bucket: r.bucket.format("%Y-%m-%dT%H:%M:%S").to_string(),
            avg_late_minutes: r.avg_late_minutes.unwrap_or(0.0),
            p95_late_minutes: r.p95_late_minutes.unwrap_or(0.0),
            max_late_minutes: r.max_late_minutes.unwrap_or(0),
            on_time_pct: r.on_time_pct.unwrap_or(0.0),
            event_count: r.event_count.unwrap_or(0),
        }
    }
}

#[derive(Clone, SimpleObject)]
pub struct StationDelayStats {
    pub station_code: String,
    pub station_desc: String,
    pub avg_late_minutes: f64,
    pub max_late_minutes: i32,
    pub on_time_pct: f64,
    pub total_events: i64,
}

#[derive(Clone, SimpleObject)]
pub struct NetworkSummary {
    pub active_trains: i64,
    pub total_stations: i64,
    pub avg_delay_minutes: f64,
    pub on_time_pct: f64,
    pub last_updated: Option<String>,
}

#[derive(Clone, SimpleObject)]
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
