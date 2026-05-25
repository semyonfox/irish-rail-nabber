use async_graphql::{Context, Object, Result};
use chrono::NaiveDate;
use sqlx::PgPool;

use super::types::{RouteSegment, TrainMovement, TrainPosition};
use crate::models::{RouteSegmentRow, TrainMovementRow, TrainPositionRow};

#[derive(Default)]
pub struct TrainQuery;

#[Object]
impl TrainQuery {
    // live train positions from the latest_train_positions view
    // scoped to recent data to avoid full hypertable scan
    async fn live_trains(
        &self,
        ctx: &Context<'_>,
        train_type: Option<String>,
    ) -> Result<Vec<TrainPosition>> {
        let pool = ctx.data::<PgPool>()?;

        let rows = if let Some(tt) = train_type {
            sqlx::query_as::<_, TrainPositionRow>(
                "SELECT DISTINCT ON (train_code)
                    train_code,
                    CASE WHEN latitude = 0 AND longitude = 0 THEN NULL ELSE latitude END AS latitude,
                    CASE WHEN latitude = 0 AND longitude = 0 THEN NULL ELSE longitude END AS longitude,
                    train_status, direction, train_type, fetched_at
                 FROM train_snapshots
                 WHERE fetched_at > NOW() - INTERVAL '2 minutes' AND train_type = $1
                 ORDER BY train_code, fetched_at DESC",
            )
            .bind(&tt)
            .fetch_all(pool)
            .await?
        } else {
            sqlx::query_as::<_, TrainPositionRow>(
                "SELECT DISTINCT ON (train_code)
                    train_code,
                    CASE WHEN latitude = 0 AND longitude = 0 THEN NULL ELSE latitude END AS latitude,
                    CASE WHEN latitude = 0 AND longitude = 0 THEN NULL ELSE longitude END AS longitude,
                    train_status, direction, train_type, fetched_at
                 FROM train_snapshots
                 WHERE fetched_at > NOW() - INTERVAL '2 minutes'
                 ORDER BY train_code, fetched_at DESC",
            )
            .fetch_all(pool)
            .await?
        };

        Ok(rows.into_iter().map(TrainPosition::from).collect())
    }

    // full journey for a specific train (all stops, most recent snapshot)
    async fn train_journey(
        &self,
        ctx: &Context<'_>,
        train_code: String,
        train_date: Option<String>,
    ) -> Result<Vec<TrainMovement>> {
        let pool = ctx.data::<PgPool>()?;

        let date = match train_date {
            Some(d) => NaiveDate::parse_from_str(&d, "%Y-%m-%d")
                .unwrap_or_else(|_| chrono::Local::now().date_naive()),
            None => chrono::Local::now().date_naive(),
        };

        let rows = sqlx::query_as::<_, TrainMovementRow>(
            "SELECT DISTINCT ON (location_order)
                train_code, train_date, location_code, location_full_name,
                location_order, location_type, train_origin, train_destination,
                scheduled_arrival, scheduled_departure,
                expected_arrival, expected_departure,
                actual_arrival, actual_departure,
                NULLIF(stop_type, '-') AS stop_type, fetched_at
             FROM train_movements
             WHERE train_code = $1 AND train_date = $2
                AND location_type <> 'T'
                AND EXISTS (
                    SELECT 1 FROM stations s WHERE s.station_code = location_code
                )
             ORDER BY location_order, fetched_at DESC",
        )
        .bind(&train_code)
        .bind(date)
        .fetch_all(pool)
        .await?;

        Ok(rows.into_iter().map(TrainMovement::from).collect())
    }

    // historical positions for a train (for trail rendering on map)
    async fn train_history(
        &self,
        ctx: &Context<'_>,
        train_code: String,
        #[graphql(default = 24)] hours: i32,
    ) -> Result<Vec<TrainPosition>> {
        let pool = ctx.data::<PgPool>()?;

        let rows = sqlx::query_as::<_, TrainPositionRow>(
            "SELECT train_code, latitude, longitude, train_status, direction, train_type, fetched_at
             FROM train_snapshots
             WHERE train_code = $1 AND fetched_at > NOW() - make_interval(hours => $2)
                AND NOT (latitude = 0 AND longitude = 0)
             ORDER BY fetched_at DESC
             LIMIT 500",
        )
        .bind(&train_code)
        .bind(hours)
        .fetch_all(pool)
        .await?;

        Ok(rows.into_iter().map(TrainPosition::from).collect())
    }

    // observed station-to-station route segments from recent train movements
    async fn route_segments(
        &self,
        ctx: &Context<'_>,
        #[graphql(default = 12)] hours: i32,
        #[graphql(default = 300)] limit: i32,
    ) -> Result<Vec<RouteSegment>> {
        let pool = ctx.data::<PgPool>()?;
        let bounded_hours = hours.clamp(1, 72);
        let bounded_limit = limit.clamp(50, 500);

        let rows = sqlx::query_as::<_, RouteSegmentRow>(
            "WITH latest_stops AS (
                SELECT DISTINCT ON (train_code, train_date, location_order)
                    train_code, train_date, location_order, location_code, fetched_at
                FROM train_movements
                WHERE fetched_at > NOW() - ($1::int * INTERVAL '1 hour')
                    AND location_type <> 'T'
                    AND location_code IS NOT NULL
                ORDER BY train_code, train_date, location_order, fetched_at DESC
             ),
             transitions AS (
                SELECT
                    train_code,
                    train_date,
                    location_code AS from_code,
                    LEAD(location_code) OVER journey AS to_code,
                    GREATEST(
                        fetched_at,
                        LEAD(fetched_at) OVER journey
                    ) AS seen_at
                FROM latest_stops
                WINDOW journey AS (
                    PARTITION BY train_code, train_date
                    ORDER BY location_order
                )
             )
             SELECT
                t.from_code AS from_station_code,
                sf.station_desc AS from_station_name,
                CASE
                    WHEN sf.latitude BETWEEN 51 AND 56 AND sf.longitude BETWEEN -11 AND -5
                    THEN sf.latitude ELSE NULL
                END AS from_latitude,
                CASE
                    WHEN sf.latitude BETWEEN 51 AND 56 AND sf.longitude BETWEEN -11 AND -5
                    THEN sf.longitude ELSE NULL
                END AS from_longitude,
                t.to_code AS to_station_code,
                st.station_desc AS to_station_name,
                CASE
                    WHEN st.latitude BETWEEN 51 AND 56 AND st.longitude BETWEEN -11 AND -5
                    THEN st.latitude ELSE NULL
                END AS to_latitude,
                CASE
                    WHEN st.latitude BETWEEN 51 AND 56 AND st.longitude BETWEEN -11 AND -5
                    THEN st.longitude ELSE NULL
                END AS to_longitude,
                COUNT(DISTINCT t.train_code || ':' || t.train_date::text) AS train_count,
                MAX(t.seen_at) AS last_seen
             FROM transitions t
             JOIN stations sf ON sf.station_code = t.from_code
             JOIN stations st ON st.station_code = t.to_code
             WHERE t.to_code IS NOT NULL
                AND t.from_code <> t.to_code
                AND sf.latitude BETWEEN 51 AND 56
                AND sf.longitude BETWEEN -11 AND -5
                AND st.latitude BETWEEN 51 AND 56
                AND st.longitude BETWEEN -11 AND -5
             GROUP BY
                t.from_code, sf.station_desc, sf.latitude, sf.longitude,
                t.to_code, st.station_desc, st.latitude, st.longitude
             ORDER BY train_count DESC, last_seen DESC
             LIMIT $2",
        )
        .bind(bounded_hours)
        .bind(bounded_limit as i64)
        .fetch_all(pool)
        .await?;

        Ok(rows.into_iter().map(RouteSegment::from).collect())
    }
}
