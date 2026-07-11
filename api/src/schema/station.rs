use async_graphql::{Context, Object, Result};
use sqlx::PgPool;

use super::bounds::{clamp_i32, STATION_BOARD_LIMIT};
use super::types::{CountryBoardEvent, Station, StationEvent};
use crate::models::CountryBoardEventRow;
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
                    "SELECT station_code, station_id, station_desc, station_alias, station_type, is_dart,
                        CASE WHEN latitude BETWEEN 51 AND 56 AND longitude BETWEEN -11 AND -5 THEN latitude ELSE NULL END AS latitude,
                        CASE WHEN latitude BETWEEN 51 AND 56 AND longitude BETWEEN -11 AND -5 THEN longitude ELSE NULL END AS longitude
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
                    "SELECT station_code, station_id, station_desc, station_alias, station_type, is_dart,
                        CASE WHEN latitude BETWEEN 51 AND 56 AND longitude BETWEEN -11 AND -5 THEN latitude ELSE NULL END AS latitude,
                        CASE WHEN latitude BETWEEN 51 AND 56 AND longitude BETWEEN -11 AND -5 THEN longitude ELSE NULL END AS longitude
                     FROM stations WHERE station_type = $1
                     ORDER BY station_desc"
                )
                .bind(st)
                .fetch_all(pool)
                .await?
            }
            (None, Some(dart)) => {
                sqlx::query_as::<_, StationRow>(
                    "SELECT station_code, station_id, station_desc, station_alias, station_type, is_dart,
                        CASE WHEN latitude BETWEEN 51 AND 56 AND longitude BETWEEN -11 AND -5 THEN latitude ELSE NULL END AS latitude,
                        CASE WHEN latitude BETWEEN 51 AND 56 AND longitude BETWEEN -11 AND -5 THEN longitude ELSE NULL END AS longitude
                     FROM stations WHERE is_dart = $1
                     ORDER BY station_desc"
                )
                .bind(dart)
                .fetch_all(pool)
                .await?
            }
            (None, None) => {
                sqlx::query_as::<_, StationRow>(
                    "SELECT station_code, station_id, station_desc, station_alias, station_type, is_dart,
                        CASE WHEN latitude BETWEEN 51 AND 56 AND longitude BETWEEN -11 AND -5 THEN latitude ELSE NULL END AS latitude,
                        CASE WHEN latitude BETWEEN 51 AND 56 AND longitude BETWEEN -11 AND -5 THEN longitude ELSE NULL END AS longitude
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
            "SELECT station_code, station_id, station_desc, station_alias, station_type, is_dart,
                CASE WHEN latitude BETWEEN 51 AND 56 AND longitude BETWEEN -11 AND -5 THEN latitude ELSE NULL END AS latitude,
                CASE WHEN latitude BETWEEN 51 AND 56 AND longitude BETWEEN -11 AND -5 THEN longitude ELSE NULL END AS longitude
             FROM stations WHERE station_code = $1"
        )
        .bind(station_code.trim().to_uppercase())
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
        let bounded_limit = clamp_i32(limit, STATION_BOARD_LIMIT.0, STATION_BOARD_LIMIT.1);

        let rows = sqlx::query_as::<_, StationEventRow>(
            "SELECT DISTINCT ON (train_code)
                train_code, station_code, train_date, origin, destination, train_type,
                direction, NULLIF(BTRIM(status), '') AS status, scheduled_arrival, scheduled_departure,
                expected_arrival, expected_departure,
                CASE
                    WHEN ABS(late_minutes) > 720 THEN NULL
                    WHEN late_minutes < -60
                        AND COALESCE(expected_arrival, expected_departure) IS NOT NULL
                        AND COALESCE(NULLIF(scheduled_arrival, TIME '00:00'), NULLIF(scheduled_departure, TIME '00:00'), scheduled_arrival, scheduled_departure) IS NOT NULL
                        AND COALESCE(expected_arrival, expected_departure) < COALESCE(NULLIF(scheduled_arrival, TIME '00:00'), NULLIF(scheduled_departure, TIME '00:00'), scheduled_arrival, scheduled_departure)
                    THEN NULL
                    ELSE late_minutes
                END AS late_minutes,
                NULLIF(BTRIM(last_location), '') AS last_location,
                due_in, fetched_at
             FROM station_events
             WHERE station_code = $1 AND fetched_at > NOW() - INTERVAL '10 minutes'
             ORDER BY train_code, fetched_at DESC
             LIMIT $2",
        )
        .bind(station_code.trim().to_uppercase())
        .bind(bounded_limit as i64)
        .fetch_all(pool)
        .await?;

        Ok(rows.into_iter().map(StationEvent::from).collect())
    }

    // country-wide arrivals/departures board from the latest station events
    async fn country_board(
        &self,
        ctx: &Context<'_>,
        #[graphql(default = 80)] limit: i32,
        #[graphql(default = 45)] minutes: i32,
    ) -> Result<Vec<CountryBoardEvent>> {
        let pool = ctx.data::<PgPool>()?;
        let bounded_limit = limit.clamp(20, 200);
        let bounded_minutes = minutes.clamp(5, 180);

        let rows = sqlx::query_as::<_, CountryBoardEventRow>(
            "WITH latest AS (
                SELECT DISTINCT ON (se.train_code, se.station_code, se.train_date)
                    se.train_code,
                    se.station_code,
                    s.station_desc,
                    se.train_date,
                    NULLIF(BTRIM(se.origin), '') AS origin,
                    NULLIF(BTRIM(se.destination), '') AS destination,
                    NULLIF(BTRIM(se.train_type), '') AS train_type,
                    NULLIF(BTRIM(se.direction), '') AS direction,
                    NULLIF(BTRIM(se.status), '') AS status,
                    NULLIF(se.scheduled_arrival, TIME '00:00') AS scheduled_arrival,
                    NULLIF(se.scheduled_departure, TIME '00:00') AS scheduled_departure,
                    NULLIF(se.expected_arrival, TIME '00:00') AS expected_arrival,
                    NULLIF(se.expected_departure, TIME '00:00') AS expected_departure,
                    CASE
                        WHEN ABS(se.late_minutes) > 720 OR se.late_minutes < -60 THEN NULL
                        ELSE se.late_minutes
                    END AS late_minutes,
                    NULLIF(BTRIM(se.last_location), '') AS last_location,
                    se.due_in,
                    se.fetched_at
                FROM station_events se
                JOIN stations s ON s.station_code = se.station_code
                WHERE se.fetched_at > NOW() - ($1::int * INTERVAL '1 minute')
                    AND (se.due_in IS NULL OR se.due_in >= -5)
                    AND (se.late_minutes IS NULL OR se.late_minutes >= -60)
                    AND COALESCE(se.expected_departure, se.expected_arrival, se.scheduled_departure, se.scheduled_arrival) IS NOT NULL
                ORDER BY se.train_code, se.station_code, se.train_date, se.fetched_at DESC
            )
            SELECT
                train_code,
                station_code,
                station_desc,
                train_date,
                origin,
                destination,
                train_type,
                direction,
                status,
                scheduled_arrival,
                scheduled_departure,
                expected_arrival,
                expected_departure,
                late_minutes,
                last_location,
                due_in,
                fetched_at
            FROM latest
            ORDER BY
                CASE
                    WHEN late_minutes >= 15 THEN 0
                    WHEN late_minutes >= 5 THEN 1
                    WHEN COALESCE(due_in, 9999) <= 10 THEN 2
                    ELSE 3
                END,
                COALESCE(due_in, 9999),
                COALESCE(expected_departure, expected_arrival, scheduled_departure, scheduled_arrival),
                fetched_at DESC
            LIMIT $2",
        )
        .bind(bounded_minutes)
        .bind(bounded_limit as i64)
        .fetch_all(pool)
        .await?;

        Ok(rows.into_iter().map(CountryBoardEvent::from).collect())
    }
}
