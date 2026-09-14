use bigdecimal::BigDecimal;
use chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, Utc};

#[derive(sqlx::FromRow, Debug)]
#[allow(dead_code)]
pub struct StationRow {
    pub station_code: String,
    pub station_id: Option<String>,
    pub station_desc: String,
    pub station_alias: Option<String>,
    pub station_type: Option<String>,
    pub is_dart: Option<bool>,
    pub latitude: Option<BigDecimal>,
    pub longitude: Option<BigDecimal>,
}

#[derive(sqlx::FromRow, Debug)]
pub struct TrainPositionRow {
    pub train_code: String,
    pub train_date: Option<NaiveDate>,
    pub latitude: Option<BigDecimal>,
    pub longitude: Option<BigDecimal>,
    pub train_status: Option<String>,
    pub direction: Option<String>,
    pub train_type: Option<String>,
    pub fetched_at: Option<NaiveDateTime>,
}

#[derive(sqlx::FromRow, Debug)]
pub struct RouteSegmentRow {
    pub from_station_code: String,
    pub from_station_name: String,
    pub from_latitude: Option<BigDecimal>,
    pub from_longitude: Option<BigDecimal>,
    pub to_station_code: String,
    pub to_station_name: String,
    pub to_latitude: Option<BigDecimal>,
    pub to_longitude: Option<BigDecimal>,
    pub train_count: i64,
    pub last_seen: Option<NaiveDateTime>,
}

#[derive(sqlx::FromRow, Debug)]
pub struct StationEventRow {
    pub train_code: String,
    pub station_code: Option<String>,
    pub train_date: Option<NaiveDate>,
    pub origin: Option<String>,
    pub destination: Option<String>,
    pub train_type: Option<String>,
    pub direction: Option<String>,
    pub status: Option<String>,
    pub scheduled_arrival: Option<NaiveTime>,
    pub scheduled_departure: Option<NaiveTime>,
    pub expected_arrival: Option<NaiveTime>,
    pub expected_departure: Option<NaiveTime>,
    pub late_minutes: Option<i32>,
    pub last_location: Option<String>,
    pub due_in: Option<i32>,
    pub fetched_at: NaiveDateTime,
}

#[derive(sqlx::FromRow, Debug)]
pub struct CountryBoardEventRow {
    pub train_code: String,
    pub station_code: String,
    pub station_desc: String,
    pub train_date: Option<NaiveDate>,
    pub origin: Option<String>,
    pub destination: Option<String>,
    pub train_type: Option<String>,
    pub direction: Option<String>,
    pub status: Option<String>,
    pub scheduled_arrival: Option<NaiveTime>,
    pub scheduled_departure: Option<NaiveTime>,
    pub expected_arrival: Option<NaiveTime>,
    pub expected_departure: Option<NaiveTime>,
    pub late_minutes: Option<i32>,
    pub last_location: Option<String>,
    pub due_in: Option<i32>,
    pub fetched_at: NaiveDateTime,
}

#[derive(sqlx::FromRow, Debug)]
pub struct TrainMovementRow {
    pub train_code: String,
    pub train_date: NaiveDate,
    pub location_code: Option<String>,
    pub location_full_name: Option<String>,
    pub location_order: i32,
    pub location_type: Option<String>,
    pub train_origin: Option<String>,
    pub train_destination: Option<String>,
    pub scheduled_arrival: Option<NaiveTime>,
    pub scheduled_departure: Option<NaiveTime>,
    pub expected_arrival: Option<NaiveTime>,
    pub expected_departure: Option<NaiveTime>,
    pub actual_arrival: Option<NaiveTime>,
    pub actual_departure: Option<NaiveTime>,
    pub stop_type: Option<String>,
    pub fetched_at: NaiveDateTime,
}

#[derive(sqlx::FromRow, Debug)]
pub struct HourlyDelayRow {
    pub hour: NaiveDateTime,
    pub station_code: Option<String>,
    pub avg_late_minutes: Option<BigDecimal>,
    pub max_late_minutes: Option<i32>,
    pub event_count: Option<i64>,
}

#[derive(sqlx::FromRow, Debug)]
pub struct DelayHistoryRow {
    pub bucket: NaiveDateTime,
    pub avg_late_minutes: Option<f64>,
    pub p95_late_minutes: Option<f64>,
    pub max_late_minutes: Option<i32>,
    pub on_time_pct: Option<f64>,
    pub event_count: Option<i64>,
}

#[derive(sqlx::FromRow, Debug)]
pub struct BusStopRow {
    pub stop_id: String,
    pub stop_code: Option<String>,
    pub stop_name: Option<String>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
}

#[derive(sqlx::FromRow, Debug)]
pub struct BusDepartureRow {
    pub entity_id: Option<String>,
    pub trip_id: Option<String>,
    pub route_id: Option<String>,
    pub route_short_name: Option<String>,
    pub route_long_name: Option<String>,
    pub operator_name: Option<String>,
    pub headsign: Option<String>,
    pub service_date: Option<NaiveDate>,
    pub scheduled_time: Option<DateTime<Utc>>,
    pub expected_time: Option<DateTime<Utc>>,
    pub delay_seconds: Option<i32>,
    pub schedule_relationship: Option<String>,
    pub fetched_at: DateTime<Utc>,
}

#[derive(sqlx::FromRow, Debug)]
pub struct BusRouteDelayRow {
    pub route_id: String,
    pub route_short_name: Option<String>,
    pub route_long_name: Option<String>,
    pub operator_name: Option<String>,
    pub avg_delay_seconds: f64,
    pub on_time_pct: f64,
    pub sample_count: i64,
    pub last_updated: DateTime<Utc>,
}

#[derive(sqlx::FromRow, Debug)]
pub struct BusVehicleRow {
    pub entity_id: Option<String>,
    pub vehicle_id: Option<String>,
    pub vehicle_label: Option<String>,
    pub trip_id: Option<String>,
    pub shape_id: Option<String>,
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
    pub source_timestamp: Option<DateTime<Utc>>,
    pub fetched_at: DateTime<Utc>,
}

#[derive(sqlx::FromRow, Debug)]
pub struct BusShapePointRow {
    pub route_id: String,
    pub route_short_name: Option<String>,
    pub shape_id: String,
    pub route_color: Option<String>,
    pub latitude: f64,
    pub longitude: f64,
    pub shape_pt_sequence: i64,
}

#[derive(sqlx::FromRow, Debug)]
pub struct BusRealtimeStatusRow {
    pub vehicles_last_success_at: Option<DateTime<Utc>>,
    pub trip_updates_last_success_at: Option<DateTime<Utc>>,
    pub last_success_at: Option<DateTime<Utc>>,
    pub is_live: bool,
}

#[derive(sqlx::FromRow, Debug)]
#[allow(dead_code)]
pub struct FetchHistoryRow {
    pub endpoint: Option<String>,
    pub record_count: Option<i32>,
    pub duration_ms: Option<i32>,
    pub status: Option<String>,
    pub error_msg: Option<String>,
    pub fetched_at: NaiveDateTime,
}

#[derive(sqlx::FromRow, Clone)]
pub struct UserRow {
    pub id: uuid::Uuid,
    pub email: String,
    pub clerk_user_id: Option<String>,
    pub display_name: Option<String>,
    pub role: String,
    pub polar_customer_id: Option<String>,
    pub polar_subscription_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl std::fmt::Debug for UserRow {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UserRow")
            .field("id", &self.id)
            .field("email", &self.email)
            .field("clerk_user_id", &self.clerk_user_id)
            .field("display_name", &self.display_name)
            .field("role", &self.role)
            .field("polar_customer_id", &self.polar_customer_id)
            .field("polar_subscription_id", &self.polar_subscription_id)
            .field("created_at", &self.created_at)
            .field("updated_at", &self.updated_at)
            .finish()
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AuthUser {
    pub id: uuid::Uuid,
    pub email: String,
    pub role: String,
}
