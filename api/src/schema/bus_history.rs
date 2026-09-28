use async_graphql::{Context, Error, Object, Result, SimpleObject};
use sqlx::{FromRow, PgPool};
use std::sync::Arc;

use super::bus::validate_identifier;
use crate::{models::AuthUser, state::QueryCache};

#[derive(Clone, SimpleObject, FromRow)]
pub struct BusHistoryPoint {
    pub bucket: String,
    pub avg_delay_seconds: f64,
    pub max_delay_seconds: i32,
    pub p95_delay_seconds: f64,
    pub on_time_pct: f64,
    pub early_count: i64,
    pub late_count: i64,
    pub sample_count: i64,
    pub last_updated: String,
}

#[derive(Default)]
pub struct BusHistoryQuery;

#[Object]
impl BusHistoryQuery {
    /// poll-weighted predictions grouped from delay bins instead of repeated stop rows
    #[graphql(complexity = 200)]
    async fn bus_delay_history(
        &self,
        ctx: &Context<'_>,
        route_id: Option<String>,
        feed_version_id: Option<i64>,
        stop_id: Option<String>,
        #[graphql(default = 24)] hours: i32,
    ) -> Result<Vec<BusHistoryPoint>> {
        let route_id = route_id
            .map(|id| validate_identifier(id, "routeId"))
            .transpose()?;
        let stop_id = stop_id
            .map(|id| validate_identifier(id, "stopId"))
            .transpose()?;
        if route_id.is_some() && stop_id.is_some() {
            return Err(Error::new("Choose either a route or a stop"));
        }
        if (route_id.is_some() || stop_id.is_some()) && feed_version_id.is_none() {
            return Err(Error::new(
                "feedVersionId is required with routeId or stopId",
            ));
        }
        if feed_version_id.is_some_and(|id| id < 1) {
            return Err(Error::new("feedVersionId must be positive"));
        }

        let role = ctx
            .data_opt::<Option<AuthUser>>()
            .and_then(|user| user.as_ref())
            .map(|user| user.role.as_str());
        let max_hours = if matches!(role, Some("coffee" | "pro" | "admin")) {
            168
        } else {
            72
        };
        let hours = hours.clamp(1, max_hours);
        let (scope_kind, scope_id) = if let Some(id) = stop_id {
            ("stop", id)
        } else if let Some(id) = route_id {
            ("route", id)
        } else {
            ("network", String::new())
        };
        let key = format!("{scope_kind}:{scope_id}:{feed_version_id:?}:{hours}");
        let pool = ctx.data::<PgPool>()?.clone();
        let result = ctx
            .data::<QueryCache>()?
            .bus_delay_history
            .try_get_with(key, async move {
                let mut tx = pool.begin().await?;
                sqlx::query("SET LOCAL statement_timeout = '15s'")
                    .execute(&mut *tx)
                    .await?;
                let rows = sqlx::query_as::<_, BusHistoryPoint>(
                    "SELECT to_char(bucket AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS bucket,
                            (SUM(delay_seconds::numeric * sample_count) / SUM(sample_count))::float8 AS avg_delay_seconds,
                            MAX(delay_seconds)::int4 AS max_delay_seconds,
                            bus_histogram_percentile(array_agg(delay_seconds), array_agg(sample_count), 0.95) AS p95_delay_seconds,
                            (100.0 * COALESCE(SUM(sample_count) FILTER (WHERE delay_seconds BETWEEN -60 AND 300), 0) / SUM(sample_count))::float8 AS on_time_pct,
                            COALESCE(SUM(sample_count) FILTER (WHERE delay_seconds < -60), 0)::bigint AS early_count,
                            COALESCE(SUM(sample_count) FILTER (WHERE delay_seconds > 300), 0)::bigint AS late_count,
                            SUM(sample_count)::bigint AS sample_count,
                            to_char(MAX(last_updated) AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS last_updated
                     FROM bus_delay_histogram
                     WHERE bucket >= time_bucket(INTERVAL '1 hour', NOW() - make_interval(hours => $1))
                       AND ($2::bigint IS NULL OR feed_version_id = $2)
                       AND scope_kind = $3 AND scope_id = $4
                     GROUP BY bucket ORDER BY bucket",
                )
                .bind(hours)
                .bind(feed_version_id)
                .bind(scope_kind)
                .bind(scope_id)
                .fetch_all(&mut *tx)
                .await?;
                tx.commit().await?;
                Ok::<_, sqlx::Error>(Arc::new(rows))
            })
            .await
            .map_err(|error| Error::new(error.to_string()))?;
        Ok((*result).clone())
    }
}
