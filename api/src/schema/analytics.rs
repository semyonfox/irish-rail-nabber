use async_graphql::{Context, Object, Result};
use sqlx::PgPool;

use super::types::*;
use crate::models::AuthUser;
use crate::models::{FetchHistoryRow, HourlyDelayRow};

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
    // hourly delay aggregates from the continuous aggregate
    async fn hourly_delays(
        &self,
        ctx: &Context<'_>,
        station_code: Option<String>,
        #[graphql(default = 24)] hours: i32,
    ) -> Result<Vec<HourlyDelay>> {
        ensure_premium(ctx)?;
        let pool = ctx.data::<PgPool>()?;

        let rows = if let Some(sc) = station_code {
            sqlx::query_as::<_, HourlyDelayRow>(
                "SELECT hour, station_code, avg_late_minutes, max_late_minutes, event_count
                 FROM hourly_delays
                 WHERE hour > NOW() - make_interval(hours => $1) AND station_code = $2
                 ORDER BY hour DESC",
            )
            .bind(hours)
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
            .bind(hours)
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

        let rows = sqlx::query_as::<_, StationDelayStatsRow>(
            "WITH recent AS (
                SELECT DISTINCT ON (train_code, station_code)
                    train_code, station_code, late_minutes
                FROM station_events
                WHERE fetched_at > NOW() - make_interval(hours => $1)
                    AND late_minutes IS NOT NULL
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
        .bind(hours)
        .bind(limit as i64)
        .fetch_all(pool)
        .await?;

        Ok(rows
            .into_iter()
            .map(|r| StationDelayStats {
                station_code: r.station_code,
                station_desc: r.station_desc,
                avg_late_minutes: r.avg_late_minutes.unwrap_or(0.0),
                max_late_minutes: r.max_late_minutes.unwrap_or(0),
                on_time_pct: r.on_time_pct.unwrap_or(0.0),
                total_events: r.total_events.unwrap_or(0),
            })
            .collect())
    }

    // network-wide summary
    async fn network_summary(&self, ctx: &Context<'_>) -> Result<NetworkSummary> {
        ensure_premium(ctx)?;
        let pool = ctx.data::<PgPool>()?;

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
        .fetch_one(pool)
        .await?;

        Ok(NetworkSummary {
            active_trains: row.active_trains.unwrap_or(0),
            total_stations: row.total_stations.unwrap_or(0),
            avg_delay_minutes: row.avg_delay_minutes.unwrap_or(0.0),
            on_time_pct: row.on_time_pct.unwrap_or(0.0),
            last_updated: row
                .last_updated
                .map(|dt| dt.format("%Y-%m-%dT%H:%M:%S").to_string()),
        })
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

        let rows = sqlx::query_as::<_, RouteReliabilityRow>(
            "WITH recent AS (
                SELECT DISTINCT ON (train_code, station_code)
                    train_code, origin, destination, late_minutes
                FROM station_events
                WHERE fetched_at > NOW() - make_interval(hours => $1)
                    AND late_minutes IS NOT NULL
                    AND origin IS NOT NULL AND destination IS NOT NULL
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
        .bind(hours)
        .bind(min_trains as i64)
        .fetch_all(pool)
        .await?;

        Ok(rows
            .into_iter()
            .map(|r| RouteReliability {
                origin: r.origin,
                destination: r.destination,
                avg_late_minutes: r.avg_late_minutes.unwrap_or(0.0),
                on_time_pct: r.on_time_pct.unwrap_or(0.0),
                train_count: r.train_count.unwrap_or(0),
            })
            .collect())
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
