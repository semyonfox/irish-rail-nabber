use async_graphql::{Context, Enum, Error, InputObject, Object, Result, SimpleObject};
use chrono::NaiveDate;
use sqlx::{FromRow, PgPool, Postgres, Transaction};

use super::{bounds::clamp_i32, bus::validate_identifier};
use crate::models::AuthUser;

#[derive(Clone, Copy, Eq, PartialEq, Enum, sqlx::Type)]
#[sqlx(type_name = "text", rename_all = "SCREAMING_SNAKE_CASE")]
enum InsightsMode {
    Rail,
    Bus,
}

impl InsightsMode {
    fn sql(self) -> &'static str {
        match self {
            Self::Rail => "RAIL",
            Self::Bus => "BUS",
        }
    }
}

#[derive(Clone, Copy, Eq, PartialEq, Enum, sqlx::Type)]
#[sqlx(type_name = "text", rename_all = "SCREAMING_SNAKE_CASE")]
enum ServiceAlertStatus {
    Active,
    Scheduled,
    BetweenWindows,
    Ended,
    WithdrawnEarly,
}

#[derive(SimpleObject, FromRow)]
struct ServiceAlert {
    mode: InsightsMode,
    alert_key: String,
    title: String,
    description: String,
    category: String,
    status: ServiceAlertStatus,
    starts_at: Option<String>,
    ends_at: Option<String>,
    first_seen: String,
    last_seen: String,
    revisions: i32,
    location_codes: Vec<String>,
    corridor_codes: Option<Vec<String>>,
    impact_events: Option<i64>,
    impact_window_end: Option<String>,
    never_ran: bool,
    impact_avg_late: Option<f64>,
    baseline_avg_late: Option<f64>,
    pre_avg_late: Option<f64>,
    pre_baseline_avg_late: Option<f64>,
    agency_ids: Vec<String>,
    routes: Vec<String>,
    stops: Vec<String>,
}

#[derive(SimpleObject)]
struct ServiceAlertPage {
    alerts: Vec<ServiceAlert>,
    has_next_page: bool,
}

#[derive(SimpleObject, FromRow)]
struct DelayStretch {
    from_id: String,
    to_id: String,
    from_name: String,
    to_name: String,
    from_lat: Option<f64>,
    from_lon: Option<f64>,
    to_lat: Option<f64>,
    to_lon: Option<f64>,
    trips: i64,
    days_with_data: i32,
    net_delay_minutes: f64,
    added_minutes: f64,
    avg_gain_minutes: f64,
    stddev_minutes: f64,
    median_gain_lower_s: Option<i32>,
    median_gain_upper_s: Option<i32>,
    gain_at_least_two_minutes_pct: Option<f64>,
    overrun_pct: Option<f64>,
    routes: Vec<String>,
}

#[derive(SimpleObject, FromRow)]
struct DwellHotspot {
    station_code: String,
    station_name: String,
    trips: i64,
    net_delay_minutes: f64,
    added_minutes: f64,
    avg_gain_minutes: f64,
    overrun_pct: Option<f64>,
}

#[derive(InputObject)]
struct InsightsDates {
    /// first service date, inclusive, YYYY-MM-DD
    from: String,
    /// last service date, inclusive, YYYY-MM-DD
    to: String,
}

#[derive(InputObject)]
struct InsightsHours {
    /// first scheduled departure hour, inclusive, in Irish local time
    start: i32,
    /// end of the band, exclusive, in Irish local time
    end: i32,
}

#[derive(Clone, Copy)]
enum DateRangeLimit {
    Alerts,
    RailRanking,
    BusStretches,
}

impl DateRangeLimit {
    fn max_days(self) -> i64 {
        match self {
            Self::Alerts => 90,
            Self::RailRanking => 31,
            Self::BusStretches => 7,
        }
    }
}

const MAX_ALERT_PAGE: i32 = 100;
const ALERTS_SQL: &str = include_str!("insights/alerts.sql");
const STRETCHES_SQL: &str = include_str!("insights/stretches.sql");
const DWELL_SQL: &str = include_str!("insights/dwell.sql");

fn admin_pool<'a>(ctx: &'a Context<'_>) -> Result<&'a PgPool> {
    let user = ctx.data_opt::<Option<AuthUser>>().and_then(Option::as_ref);
    if !user.is_some_and(|user| user.role == "admin") {
        return Err(Error::new("Admin access required"));
    }
    ctx.data::<PgPool>()
}

fn dates(input: InsightsDates, limit: DateRangeLimit) -> Result<(NaiveDate, NaiveDate)> {
    let parse = |value: &str| {
        NaiveDate::parse_from_str(value, "%Y-%m-%d")
            .ok()
            .filter(|date| value.len() == 10 && date.format("%Y-%m-%d").to_string() == value)
            .filter(|_| value >= "0001-01-01")
            .ok_or_else(|| Error::new("Use dates in YYYY-MM-DD format"))
    };
    let from = parse(&input.from)?;
    let to = parse(&input.to)?;
    let max_days = limit.max_days();
    if !(0..max_days).contains(&(to - from).num_days()) {
        let message = match limit {
            DateRangeLimit::BusStretches => format!(
                "Select a bus date range of 1 to {max_days} days"
            ),
            _ => format!("Select a date range of 1 to {max_days} days"),
        };
        return Err(Error::new(message));
    }
    Ok((from, to))
}

fn hours(input: Option<InsightsHours>) -> Result<(i16, i16)> {
    let Some(InsightsHours { start, end }) = input else {
        return Ok((0, 24));
    };
    if !(0..24).contains(&start) || !(start + 1..=24).contains(&end) {
        return Err(Error::new("Use an hour band with 0 <= start < end <= 24"));
    }
    Ok((start as i16, end as i16))
}

fn query_error(error: sqlx::Error) -> Error {
    tracing::error!(%error, "insights query failed");
    Error::new("Insights data unavailable")
}

async fn insights_transaction(pool: &PgPool) -> Result<Transaction<'static, Postgres>> {
    let mut tx = pool.begin().await.map_err(query_error)?;
    sqlx::query("SET LOCAL statement_timeout = '5s'")
        .execute(&mut *tx)
        .await
        .map_err(query_error)?;
    // parallel queries can exhaust shared memory in the database container
    sqlx::query("SET LOCAL max_parallel_workers_per_gather = 0")
        .execute(&mut *tx)
        .await
        .map_err(query_error)?;
    sqlx::query("SET LOCAL plan_cache_mode = force_custom_plan")
        .execute(&mut *tx)
        .await
        .map_err(query_error)?;
    Ok(tx)
}

#[derive(Default)]
pub struct InsightsQuery;

#[Object]
impl InsightsQuery {
    /// Notice windows overlapping the selected Irish dates, newest start first.
    #[graphql(complexity = "50 + child_complexity * 10")]
    async fn service_alerts(
        &self,
        ctx: &Context<'_>,
        range: InsightsDates,
        mode: Option<InsightsMode>,
        category: Option<String>,
        limit: Option<i32>,
        page: Option<i32>,
    ) -> Result<ServiceAlertPage> {
        let pool = admin_pool(ctx)?;
        let (from, to) = dates(range, DateRangeLimit::Alerts)?;
        let category = category
            .map(|value| validate_identifier(value, "category"))
            .transpose()?;
        let limit = i64::from(clamp_i32(limit.unwrap_or(25), 1, 100));
        let page = clamp_i32(page.unwrap_or(1), 1, MAX_ALERT_PAGE);
        let mut tx = insights_transaction(pool).await?;
        let mut alerts = sqlx::query_as::<_, ServiceAlert>(ALERTS_SQL)
            .bind(mode.map(InsightsMode::sql))
            .bind(category)
            .bind(None::<String>)
            .bind(from)
            .bind(to)
            .bind(limit + 1)
            .bind((i64::from(page) - 1) * limit)
            .fetch_all(&mut *tx)
            .await
            .map_err(query_error)?;
        tx.commit().await.map_err(query_error)?;
        let has_next_page = alerts.len() > limit as usize && page < MAX_ALERT_PAGE;
        alerts.truncate(limit as usize);
        Ok(ServiceAlertPage {
            alerts,
            has_next_page,
        })
    }

    /// Latest revision of an alert and any computed rail impact.
    async fn service_alert(
        &self,
        ctx: &Context<'_>,
        mode: InsightsMode,
        alert_key: String,
    ) -> Result<Option<ServiceAlert>> {
        let pool = admin_pool(ctx)?;
        let key = validate_identifier(alert_key, "alertKey")?;
        let mut tx = insights_transaction(pool).await?;
        let alert = sqlx::query_as(ALERTS_SQL)
            .bind(mode.sql())
            .bind(None::<String>)
            .bind(key)
            .bind(None::<NaiveDate>)
            .bind(None::<NaiveDate>)
            .bind(1_i64)
            .bind(0_i64)
            .fetch_optional(&mut *tx)
            .await
            .map_err(query_error)?;
        tx.commit().await.map_err(query_error)?;
        Ok(alert)
    }

    /// Directed stretches ranked by net delay.
    #[graphql(complexity = "100 + child_complexity * 10")]
    async fn delay_stretches(
        &self,
        ctx: &Context<'_>,
        mode: InsightsMode,
        range: InsightsDates,
        hour_band: Option<InsightsHours>,
        min_trips: Option<i32>,
        limit: Option<i32>,
    ) -> Result<Vec<DelayStretch>> {
        let pool = admin_pool(ctx)?;
        let date_limit = match mode {
            InsightsMode::Rail => DateRangeLimit::RailRanking,
            InsightsMode::Bus => DateRangeLimit::BusStretches,
        };
        let (from, to) = dates(range, date_limit)?;
        let (start, end) = hours(hour_band)?;
        let mut tx = insights_transaction(pool).await?;
        let stretches = sqlx::query_as(STRETCHES_SQL)
            .bind(mode.sql())
            .bind(from)
            .bind(to)
            .bind(start)
            .bind(end)
            .bind(i64::from(clamp_i32(min_trips.unwrap_or(10), 1, 100_000)))
            .bind(i64::from(clamp_i32(limit.unwrap_or(30), 1, 100)))
            .fetch_all(&mut *tx)
            .await
            .map_err(query_error)?;
        tx.commit().await.map_err(query_error)?;
        Ok(stretches)
    }

    /// Rail stations ranked by net delay while stopped.
    #[graphql(complexity = "50 + child_complexity * 10")]
    async fn rail_dwell_hotspots(
        &self,
        ctx: &Context<'_>,
        range: InsightsDates,
        hour_band: Option<InsightsHours>,
        min_trips: Option<i32>,
        limit: Option<i32>,
    ) -> Result<Vec<DwellHotspot>> {
        let pool = admin_pool(ctx)?;
        let (from, to) = dates(range, DateRangeLimit::RailRanking)?;
        let (start, end) = hours(hour_band)?;
        let mut tx = insights_transaction(pool).await?;
        let hotspots = sqlx::query_as(DWELL_SQL)
            .bind(from)
            .bind(to)
            .bind(start)
            .bind(end)
            .bind(i64::from(clamp_i32(min_trips.unwrap_or(10), 1, 100_000)))
            .bind(i64::from(clamp_i32(limit.unwrap_or(10), 1, 100)))
            .fetch_all(&mut *tx)
            .await
            .map_err(query_error)?;
        tx.commit().await.map_err(query_error)?;
        Ok(hotspots)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::QueryCache;
    use async_graphql::Request;

    fn window(from: &str, to: &str) -> InsightsDates {
        InsightsDates {
            from: from.into(),
            to: to.into(),
        }
    }

    #[test]
    fn date_and_hour_bounds_include_only_supported_windows() {
        use DateRangeLimit::{Alerts, BusStretches, RailRanking};

        assert!(dates(window("2026-03-01", "2026-03-31"), RailRanking).is_ok());
        assert!(dates(window("2026-03-01", "2026-04-01"), RailRanking).is_err());
        assert!(dates(window("2026-03-01", "2026-03-07"), BusStretches).is_ok());
        assert!(dates(window("2026-03-01", "2026-03-08"), BusStretches).is_err());
        assert!(dates(window("2026-01-01", "2026-03-31"), Alerts).is_ok());
        assert!(dates(window("2026-01-01", "2026-04-01"), Alerts).is_err());
        assert!(dates(window("2026-03-02", "2026-03-01"), Alerts).is_err());
        assert!(dates(window("2026-3-01", "2026-03-01"), Alerts).is_err());
        assert_eq!(hours(None).unwrap(), (0, 24));
        assert_eq!(
            hours(Some(InsightsHours { start: 7, end: 10 })).unwrap(),
            (7, 10)
        );
        assert!(hours(Some(InsightsHours { start: 16, end: 4 })).is_err());
        assert!(hours(Some(InsightsHours { start: 0, end: 25 })).is_err());
    }

    #[tokio::test]
    async fn every_insights_field_checks_admin_before_database_access() {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgresql://localhost/insights_schema_validation")
            .unwrap();
        let schema = crate::schema::build_schema(pool, QueryCache::new());
        let queries = [
            r#"query($page: Int) { serviceAlerts(range: {from: "bad", to: "bad"}, page: $page) { hasNextPage } }"#,
            r#"{ serviceAlert(mode: RAIL, alertKey: "") { title } }"#,
            r#"{ delayStretches(mode: BUS, range: {from: "bad", to: "bad"}) { trips } }"#,
            r#"{ railDwellHotspots(range: {from: "bad", to: "bad"}) { trips } }"#,
        ];
        for role in [
            None,
            Some("free"),
            Some("coffee"),
            Some("pro"),
            Some("admin"),
        ] {
            let user = role.map(|role| AuthUser {
                id: uuid::Uuid::nil(),
                email: "test@example.com".into(),
                role: role.into(),
            });
            for query in queries {
                let response = schema.execute(Request::new(query).data(user.clone())).await;
                let expected = match (role, query.contains("alertKey")) {
                    (Some("admin"), true) => "alertKey must not be empty",
                    (Some("admin"), false) => "Use dates in YYYY-MM-DD format",
                    _ => "Admin access required",
                };
                assert_eq!(response.errors.len(), 1, "{:?}", response.errors);
                assert_eq!(response.errors[0].message, expected);
            }
        }
    }
}
