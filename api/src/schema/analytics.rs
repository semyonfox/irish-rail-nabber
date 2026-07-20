use async_graphql::{Context, Object, Result};
use sqlx::PgPool;
use std::sync::Arc;

use super::bounds::{
    clamp_i32, ANALYTICS_HOURS, ROUTE_RELIABILITY_HOURS, ROUTE_RELIABILITY_MIN_TRAINS,
    STATION_DELAY_STATS_LIMIT,
};
use super::types::*;
use crate::models::AuthUser;
use crate::models::{DelayHistoryRow, FetchHistoryRow, HourlyDelayRow};
use crate::state::QueryCache;

#[derive(Default)]
pub struct AnalyticsQuery;

fn ensure_premium(ctx: &Context<'_>) -> Result<()> {
    let user = ctx.data_opt::<Option<AuthUser>>().and_then(|u| u.as_ref());
    match user {
        Some(u) if matches!(u.role.as_str(), "coffee" | "pro" | "admin") => Ok(()),
        Some(_) => Err("coffee or pro subscription required".into()),
        None => Err("authentication required".into()),
    }
}

#[Object]
impl AnalyticsQuery {
    /// Delay trend buckets from the retained station-event history.
    /// `hours = 0` means all retained history; callers can choose hour, day, or week buckets.
    async fn delay_history(
        &self,
        ctx: &Context<'_>,
        station_code: Option<String>,
        #[graphql(default = 168)] hours: i32,
        #[graphql(default = "hour")] bucket: String,
        since: Option<String>,
    ) -> Result<Vec<DelayHistoryPoint>> {
        ensure_premium(ctx)?;
        let pool = ctx.data::<PgPool>()?;
        let cache = ctx.data::<QueryCache>()?;

        if !(hours == 0 || (1..=8_784).contains(&hours)) {
            return Err("hours must be between 1 and 8784, or 0 for all retained history".into());
        }
        if !matches!(bucket.as_str(), "hour" | "day" | "week") {
            return Err("bucket must be hour, day, or week".into());
        }
        let since = since
            .map(|value| {
                chrono::NaiveDateTime::parse_from_str(&value, "%Y-%m-%dT%H:%M:%S")
                    .map_err(|_| async_graphql::Error::new("since must be an ISO local timestamp"))
            })
            .transpose()?;

        let station_code = station_code.map(|code| code.trim().to_uppercase());
        let cache_key = format!(
            "{}:{}:{}:{}",
            station_code.as_deref().unwrap_or("*"),
            hours,
            bucket,
            since.map(|value| value.to_string()).unwrap_or_default()
        );
        let scope_code = station_code.unwrap_or_default();
        let pool = pool.clone();
        let result = cache.delay_history.try_get_with(cache_key, async move {
            let rows = sqlx::query_as::<_, DelayHistoryRow>(
            "SELECT
                date_trunc($3, bucket) AS bucket,
                (SUM(avg_late_minutes * event_count) / NULLIF(SUM(event_count), 0))::float8 AS avg_late_minutes,
                (SUM(p95_late_minutes * event_count) / NULLIF(SUM(event_count), 0))::float8 AS p95_late_minutes,
                MAX(max_late_minutes) AS max_late_minutes,
                (SUM(on_time_pct * event_count) / NULLIF(SUM(event_count), 0))::float8 AS on_time_pct,
                SUM(event_count)::int8 AS event_count
             FROM delay_history_hourly
             WHERE ($1 = 0 OR bucket > NOW() - make_interval(hours => $1))
                AND scope_code = $2
                AND ($4 IS NULL OR bucket >= $4)
             GROUP BY 1
             ORDER BY 1",
        )
        .bind(hours)
        .bind(scope_code)
        .bind(bucket)
        .bind(since)
            .fetch_all(&pool)
            .await?;

            Ok::<_, sqlx::Error>(Arc::new(
                rows.into_iter().map(DelayHistoryPoint::from).collect(),
            ))
        }).await.map_err(|error| async_graphql::Error::new(error.to_string()))?;

        Ok((*result).clone())
    }

    // hourly delay aggregates from the continuous aggregate
    async fn hourly_delays(
        &self,
        ctx: &Context<'_>,
        station_code: Option<String>,
        #[graphql(default = 24)] hours: i32,
    ) -> Result<Vec<HourlyDelay>> {
        ensure_premium(ctx)?;
        let pool = ctx.data::<PgPool>()?;
        let bounded_hours = clamp_i32(hours, ANALYTICS_HOURS.0, ANALYTICS_HOURS.1);

        let rows = if let Some(sc) = station_code {
            sqlx::query_as::<_, HourlyDelayRow>(
                "SELECT hour, station_code, avg_late_minutes, max_late_minutes, event_count
                 FROM hourly_delays
                 WHERE hour > NOW() - make_interval(hours => $1) AND station_code = $2
                 ORDER BY hour DESC",
            )
            .bind(bounded_hours)
            .bind(&sc)
            .fetch_all(pool)
            .await?
        } else {
            sqlx::query_as::<_, HourlyDelayRow>(
                "SELECT hour, station_code, avg_late_minutes, max_late_minutes, event_count
                 FROM hourly_delays
                 WHERE hour > NOW() - make_interval(hours => $1)
                 ORDER BY hour DESC",
            )
            .bind(bounded_hours)
            .fetch_all(pool)
            .await?
        };

        Ok(rows.into_iter().map(HourlyDelay::from).collect())
    }

    // per-station delay statistics
    async fn station_delay_stats(
        &self,
        ctx: &Context<'_>,
        #[graphql(default = 24)] hours: i32,
        #[graphql(default = 50)] limit: i32,
    ) -> Result<Vec<StationDelayStats>> {
        ensure_premium(ctx)?;
        let pool = ctx.data::<PgPool>()?;
        let cache = ctx.data::<QueryCache>()?;
        let bounded_hours = clamp_i32(hours, ANALYTICS_HOURS.0, ANALYTICS_HOURS.1);
        let bounded_limit = clamp_i32(
            limit,
            STATION_DELAY_STATS_LIMIT.0,
            STATION_DELAY_STATS_LIMIT.1,
        );

        let cache_key = format!("{bounded_hours}:{bounded_limit}");
        let pool = pool.clone();
        let result = cache.station_delay_stats.try_get_with(cache_key, async move {
            let rows = sqlx::query_as::<_, StationDelayStatsRow>(
            "WITH recent AS (
                SELECT DISTINCT ON (train_code, station_code)
                    train_code, station_code, late_minutes
                FROM station_events
                WHERE fetched_at > NOW() - make_interval(hours => $1)
                    AND late_minutes IS NOT NULL
                    AND NOT (
                        ABS(late_minutes) > 720
                        OR (
                            late_minutes < -60
                            AND COALESCE(expected_arrival, expected_departure) IS NOT NULL
                            AND COALESCE(NULLIF(scheduled_arrival, TIME '00:00'), NULLIF(scheduled_departure, TIME '00:00'), scheduled_arrival, scheduled_departure) IS NOT NULL
                            AND COALESCE(expected_arrival, expected_departure) < COALESCE(NULLIF(scheduled_arrival, TIME '00:00'), NULLIF(scheduled_departure, TIME '00:00'), scheduled_arrival, scheduled_departure)
                        )
                    )
                ORDER BY train_code, station_code, fetched_at DESC
            )
            SELECT
                r.station_code,
                s.station_desc,
                AVG(r.late_minutes)::float8 AS avg_late_minutes,
                MAX(r.late_minutes) AS max_late_minutes,
                (COUNT(*) FILTER (WHERE r.late_minutes <= 5) * 100.0 / NULLIF(COUNT(*), 0))::float8 AS on_time_pct,
                COUNT(*) AS total_events
            FROM recent r
            JOIN stations s ON r.station_code = s.station_code
            GROUP BY r.station_code, s.station_desc
            HAVING COUNT(*) >= 3
            ORDER BY avg_late_minutes DESC
            LIMIT $2"
        )
        .bind(bounded_hours)
        .bind(bounded_limit as i64)
            .fetch_all(&pool)
            .await?;

            Ok::<_, sqlx::Error>(Arc::new(rows
                .into_iter()
                .map(|r| StationDelayStats {
                    station_code: r.station_code,
                    station_desc: r.station_desc,
                    avg_late_minutes: r.avg_late_minutes.unwrap_or(0.0),
                    max_late_minutes: r.max_late_minutes.unwrap_or(0),
                    on_time_pct: r.on_time_pct.unwrap_or(0.0),
                    total_events: r.total_events.unwrap_or(0),
                })
                .collect()))
        }).await.map_err(|error| async_graphql::Error::new(error.to_string()))?;

        Ok((*result).clone())
    }

    // network-wide summary
    async fn network_summary(&self, ctx: &Context<'_>) -> Result<NetworkSummary> {
        ensure_premium(ctx)?;
        let pool = ctx.data::<PgPool>()?;
        let cache = ctx.data::<QueryCache>()?;

        let pool = pool.clone();
        let result = cache.network_summary.try_get_with((), async move {
            let row = sqlx::query_as::<_, NetworkSummaryRow>(
            "WITH active AS (
                SELECT DISTINCT ON (train_code) train_code, fetched_at
                FROM train_snapshots
                WHERE fetched_at > NOW() - INTERVAL '2 minutes'
                ORDER BY train_code, fetched_at DESC
            ),
            delays AS (
                SELECT DISTINCT ON (train_code, station_code)
                    late_minutes
                FROM station_events
                WHERE fetched_at > NOW() - INTERVAL '1 hour'
                    AND late_minutes IS NOT NULL
                    AND NOT (
                        ABS(late_minutes) > 720
                        OR (
                            late_minutes < -60
                            AND COALESCE(expected_arrival, expected_departure) IS NOT NULL
                            AND COALESCE(NULLIF(scheduled_arrival, TIME '00:00'), NULLIF(scheduled_departure, TIME '00:00'), scheduled_arrival, scheduled_departure) IS NOT NULL
                            AND COALESCE(expected_arrival, expected_departure) < COALESCE(NULLIF(scheduled_arrival, TIME '00:00'), NULLIF(scheduled_departure, TIME '00:00'), scheduled_arrival, scheduled_departure)
                        )
                    )
                ORDER BY train_code, station_code, fetched_at DESC
            )
            SELECT
                (SELECT COUNT(*) FROM active)::int8 AS active_trains,
                (SELECT COUNT(*) FROM stations)::int8 AS total_stations,
                COALESCE((SELECT AVG(late_minutes)::float8 FROM delays), 0.0) AS avg_delay_minutes,
                COALESCE(
                    (SELECT (COUNT(*) FILTER (WHERE late_minutes <= 5) * 100.0 / NULLIF(COUNT(*), 0))::float8 FROM delays),
                    0.0
                ) AS on_time_pct,
                (SELECT MAX(fetched_at) FROM active) AS last_updated"
        )
            .fetch_one(&pool)
            .await?;

            Ok::<_, sqlx::Error>(Arc::new(NetworkSummary {
                active_trains: row.active_trains.unwrap_or(0),
                total_stations: row.total_stations.unwrap_or(0),
                avg_delay_minutes: row.avg_delay_minutes.unwrap_or(0.0),
                on_time_pct: row.on_time_pct.unwrap_or(0.0),
                last_updated: row
                    .last_updated
                    .map(|dt| dt.format("%Y-%m-%dT%H:%M:%S").to_string()),
            }))
        }).await.map_err(|error| async_graphql::Error::new(error.to_string()))?;

        Ok((*result).clone())
    }

    // route reliability grouped by origin-destination
    async fn route_reliability(
        &self,
        ctx: &Context<'_>,
        #[graphql(default = 24)] hours: i32,
        #[graphql(default = 3)] min_trains: i32,
    ) -> Result<Vec<RouteReliability>> {
        ensure_premium(ctx)?;
        let pool = ctx.data::<PgPool>()?;
        let cache = ctx.data::<QueryCache>()?;
        let bounded_hours = clamp_i32(hours, ROUTE_RELIABILITY_HOURS.0, ROUTE_RELIABILITY_HOURS.1);
        let bounded_min_trains = clamp_i32(
            min_trains,
            ROUTE_RELIABILITY_MIN_TRAINS.0,
            ROUTE_RELIABILITY_MIN_TRAINS.1,
        );

        let cache_key = format!("{bounded_hours}:{bounded_min_trains}");
        let pool = pool.clone();
        let result = cache.route_reliability.try_get_with(cache_key, async move {
            let rows = sqlx::query_as::<_, RouteReliabilityRow>(
            "WITH recent AS (
                SELECT DISTINCT ON (train_code, station_code)
                    train_code, origin, destination, late_minutes
                FROM station_events
                WHERE fetched_at > NOW() - make_interval(hours => $1)
                    AND late_minutes IS NOT NULL
                    AND origin IS NOT NULL AND destination IS NOT NULL
                    AND NOT (
                        ABS(late_minutes) > 720
                        OR (
                            late_minutes < -60
                            AND COALESCE(expected_arrival, expected_departure) IS NOT NULL
                            AND COALESCE(NULLIF(scheduled_arrival, TIME '00:00'), NULLIF(scheduled_departure, TIME '00:00'), scheduled_arrival, scheduled_departure) IS NOT NULL
                            AND COALESCE(expected_arrival, expected_departure) < COALESCE(NULLIF(scheduled_arrival, TIME '00:00'), NULLIF(scheduled_departure, TIME '00:00'), scheduled_arrival, scheduled_departure)
                        )
                    )
                ORDER BY train_code, station_code, fetched_at DESC
            )
            SELECT
                origin,
                destination,
                AVG(late_minutes)::float8 AS avg_late_minutes,
                (COUNT(*) FILTER (WHERE late_minutes <= 5) * 100.0 / NULLIF(COUNT(*), 0))::float8 AS on_time_pct,
                COUNT(DISTINCT train_code) AS train_count
            FROM recent
            GROUP BY origin, destination
            HAVING COUNT(DISTINCT train_code) >= $2
            ORDER BY avg_late_minutes DESC"
        )
        .bind(bounded_hours)
        .bind(bounded_min_trains as i64)
            .fetch_all(&pool)
            .await?;

            Ok::<_, sqlx::Error>(Arc::new(rows
                .into_iter()
                .map(|r| RouteReliability {
                    origin: r.origin,
                    destination: r.destination,
                    avg_late_minutes: r.avg_late_minutes.unwrap_or(0.0),
                    on_time_pct: r.on_time_pct.unwrap_or(0.0),
                    train_count: r.train_count.unwrap_or(0),
                })
                .collect()))
        }).await.map_err(|error| async_graphql::Error::new(error.to_string()))?;

        Ok((*result).clone())
    }

    // fetch status for monitoring
    async fn fetch_status(&self, ctx: &Context<'_>) -> Result<Vec<FetchStatus>> {
        ensure_premium(ctx)?;
        let pool = ctx.data::<PgPool>()?;

        let rows = sqlx::query_as::<_, FetchHistoryRow>(
            "SELECT DISTINCT ON (endpoint)
                endpoint, record_count, duration_ms, status, error_msg, fetched_at
             FROM fetch_history
             ORDER BY endpoint, fetched_at DESC",
        )
        .fetch_all(pool)
        .await?;

        Ok(rows.into_iter().map(FetchStatus::from).collect())
    }
}

// internal row types for complex aggregate queries
#[derive(sqlx::FromRow)]
struct StationDelayStatsRow {
    station_code: String,
    station_desc: String,
    avg_late_minutes: Option<f64>,
    max_late_minutes: Option<i32>,
    on_time_pct: Option<f64>,
    total_events: Option<i64>,
}

#[derive(sqlx::FromRow)]
struct NetworkSummaryRow {
    active_trains: Option<i64>,
    total_stations: Option<i64>,
    avg_delay_minutes: Option<f64>,
    on_time_pct: Option<f64>,
    last_updated: Option<chrono::NaiveDateTime>,
}

#[derive(sqlx::FromRow)]
struct RouteReliabilityRow {
    origin: String,
    destination: String,
    avg_late_minutes: Option<f64>,
    on_time_pct: Option<f64>,
    train_count: Option<i64>,
}
