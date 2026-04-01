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
    pub latitude: Option<BigDecimal>,
    pub longitude: Option<BigDecimal>,
    pub train_status: Option<String>,
    pub direction: Option<String>,
    pub fetched_at: Option<NaiveDateTime>,
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
    pub password_hash: String,
    pub display_name: Option<String>,
    pub role: String,
    pub stripe_customer_id: Option<String>,
    pub stripe_subscription_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl std::fmt::Debug for UserRow {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UserRow")
            .field("id", &self.id)
            .field("email", &self.email)
            .field("password_hash", &"[REDACTED]")
            .field("display_name", &self.display_name)
            .field("role", &self.role)
            .field("stripe_customer_id", &self.stripe_customer_id)
            .field("stripe_subscription_id", &self.stripe_subscription_id)
            .field("created_at", &self.created_at)
            .field("updated_at", &self.updated_at)
            .finish()
    }
}

#[derive(sqlx::FromRow, Debug)]
pub struct RefreshTokenRow {
    pub id: uuid::Uuid,
    pub user_id: uuid::Uuid,
    pub token_hash: String,
    pub expires_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AuthUser {
    pub id: uuid::Uuid,
    pub email: String,
    pub role: String,
}
