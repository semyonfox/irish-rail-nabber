use async_graphql::{Context, Object, Result};
use sqlx::PgPool;

use super::types::{Station, StationEvent};
use crate::models::StationEventRow;
use crate::models::StationRow;

#[derive(Default)]
pub struct StationQuery;

#[Object]
impl StationQuery {
    // all stations, optionally filtered by type or dart status
    async fn stations(
        &self,
        ctx: &Context<'_>,
        station_type: Option<String>,
        is_dart: Option<bool>,
    ) -> Result<Vec<Station>> {
        let pool = ctx.data::<PgPool>()?;

        let rows = match (&station_type, is_dart) {
            (Some(st), Some(dart)) => {
                sqlx::query_as::<_, StationRow>(
                    "SELECT station_code, station_id, station_desc, station_alias, station_type, is_dart, latitude, longitude
                     FROM stations WHERE station_type = $1 AND is_dart = $2
                     ORDER BY station_desc"
                )
                .bind(st)
                .bind(dart)
                .fetch_all(pool)
                .await?
            }
            (Some(st), None) => {
                sqlx::query_as::<_, StationRow>(
                    "SELECT station_code, station_id, station_desc, station_alias, station_type, is_dart, latitude, longitude
                     FROM stations WHERE station_type = $1
                     ORDER BY station_desc"
                )
                .bind(st)
                .fetch_all(pool)
                .await?
            }
            (None, Some(dart)) => {
                sqlx::query_as::<_, StationRow>(
                    "SELECT station_code, station_id, station_desc, station_alias, station_type, is_dart, latitude, longitude
                     FROM stations WHERE is_dart = $1
                     ORDER BY station_desc"
                )
                .bind(dart)
                .fetch_all(pool)
                .await?
            }
            (None, None) => {
                sqlx::query_as::<_, StationRow>(
                    "SELECT station_code, station_id, station_desc, station_alias, station_type, is_dart, latitude, longitude
                     FROM stations ORDER BY station_desc"
                )
                .fetch_all(pool)
                .await?
            }
        };

        Ok(rows.into_iter().map(Station::from).collect())
    }

    // single station by code
    async fn station(&self, ctx: &Context<'_>, station_code: String) -> Result<Option<Station>> {
        let pool = ctx.data::<PgPool>()?;

        let row = sqlx::query_as::<_, StationRow>(
            "SELECT station_code, station_id, station_desc, station_alias, station_type, is_dart, latitude, longitude
             FROM stations WHERE station_code = $1"
        )
        .bind(&station_code)
        .fetch_optional(pool)
        .await?;

        Ok(row.map(Station::from))
    }

    // live station board: latest events for a specific station
    async fn station_board(
        &self,
        ctx: &Context<'_>,
        station_code: String,
        #[graphql(default = 20)] limit: i32,
    ) -> Result<Vec<StationEvent>> {
        let pool = ctx.data::<PgPool>()?;

        let rows = sqlx::query_as::<_, StationEventRow>(
            "SELECT DISTINCT ON (train_code)
                train_code, station_code, train_date, origin, destination, train_type,
                direction, status, scheduled_arrival, scheduled_departure,
                expected_arrival, expected_departure, late_minutes, last_location,
                due_in, fetched_at
             FROM station_events
             WHERE station_code = $1 AND fetched_at > NOW() - INTERVAL '10 minutes'
             ORDER BY train_code, fetched_at DESC
             LIMIT $2",
        )
        .bind(&station_code)
        .bind(limit as i64)
        .fetch_all(pool)
        .await?;

        Ok(rows.into_iter().map(StationEvent::from).collect())
    }
}
