use async_graphql::{Context, Object, Result};
use chrono::NaiveDate;
use sqlx::PgPool;

use super::types::{TrainMovement, TrainPosition};
use crate::models::{TrainMovementRow, TrainPositionRow};

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
                    train_code, latitude, longitude, train_status, direction, fetched_at
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
                    train_code, latitude, longitude, train_status, direction, fetched_at
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
                stop_type, fetched_at
             FROM train_movements
             WHERE train_code = $1 AND train_date = $2
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
            "SELECT train_code, latitude, longitude, train_status, direction, fetched_at
             FROM train_snapshots
             WHERE train_code = $1 AND fetched_at > NOW() - make_interval(hours => $2)
             ORDER BY fetched_at DESC
             LIMIT 500",
        )
        .bind(&train_code)
        .bind(hours)
        .fetch_all(pool)
        .await?;

        Ok(rows.into_iter().map(TrainPosition::from).collect())
    }
}
