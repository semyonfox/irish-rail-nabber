use async_graphql::{Context, Error, Object, Result};
use sqlx::PgPool;
use std::sync::Arc;

use super::types::{
    BusDeparture, BusRealtimeStatus, BusRouteDelay, BusRouteShape, BusShapePoint, BusStop,
    BusVehicle,
};
use crate::models::{
    AuthUser, BusDepartureRow, BusRealtimeStatusRow, BusRouteDelayRow, BusShapePointRow,
    BusStopRow, BusVehicleRow,
};
use crate::state::QueryCache;

const MAX_IDENTIFIER_LENGTH: usize = 255;
const MAX_SEARCH_LENGTH: usize = 100;
const BUS_STOPS_LIMIT: (i32, i32) = (1, 200);
const BUS_STOP_BOARD_LIMIT: (i32, i32) = (1, 200);
const BUS_ROUTE_DELAY_HOURS: (i32, i32) = (1, 168);
const PUBLIC_BUS_ROUTE_DELAY_MAX_HOURS: i32 = 72;
const BUS_ROUTE_DELAY_LIMIT: (i32, i32) = (1, 100);
const BUS_VEHICLE_LIMIT: (i32, i32) = (1, 3_000);
const BUS_ROUTE_SHAPE_LIMIT: (i32, i32) = (1, 100);
const BUS_SHAPE_POINTS_PER_SHAPE: i64 = 500;
const BUS_SCHEDULED_ROUTE_SHAPE_LIMIT: (i32, i32) = (1, 40);
const BUS_SCHEDULED_SHAPE_POINTS_PER_SHAPE: i64 = 300;

#[derive(Default)]
pub struct BusQuery;

fn validate_identifier(value: String, name: &str) -> Result<String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(Error::new(format!("{name} must not be empty")));
    }
    if value.chars().count() > MAX_IDENTIFIER_LENGTH {
        return Err(Error::new(format!(
            "{name} must be at most {MAX_IDENTIFIER_LENGTH} characters"
        )));
    }
    Ok(value.to_owned())
}

fn search_pattern(search: Option<String>) -> Result<Option<String>> {
    let Some(search) = search else {
        return Ok(None);
    };
    let search = search.trim();
    if search.is_empty() {
        return Ok(None);
    }
    if search.chars().count() > MAX_SEARCH_LENGTH {
        return Err(Error::new(format!(
            "search must be at most {MAX_SEARCH_LENGTH} characters"
        )));
    }

    let escaped = search
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    Ok(Some(format!("%{escaped}%")))
}

fn max_bus_route_delay_hours(role: Option<&str>) -> i32 {
    if matches!(role, Some("coffee" | "pro" | "admin")) {
        BUS_ROUTE_DELAY_HOURS.1
    } else {
        PUBLIC_BUS_ROUTE_DELAY_MAX_HOURS
    }
}

fn bus_route_delay_hours(ctx: &Context<'_>, hours: i32) -> i32 {
    let role = ctx
        .data_opt::<Option<AuthUser>>()
        .and_then(|user| user.as_ref())
        .map(|user| user.role.as_str());
    hours.clamp(BUS_ROUTE_DELAY_HOURS.0, max_bus_route_delay_hours(role))
}

fn group_bus_route_shapes(rows: Vec<BusShapePointRow>) -> Vec<BusRouteShape> {
    let mut shapes: Vec<BusRouteShape> = Vec::new();

    for row in rows {
        let starts_new_shape = shapes
            .last()
            .is_none_or(|shape| shape.route_id != row.route_id || shape.shape_id != row.shape_id);
        if starts_new_shape {
            shapes.push(BusRouteShape {
                route_id: row.route_id.clone(),
                route_short_name: row.route_short_name.clone(),
                shape_id: row.shape_id.clone(),
                route_color: row.route_color.clone(),
                points: Vec::new(),
            });
        }
        shapes
            .last_mut()
            .expect("a route shape was inserted before its point")
            .points
            .push(BusShapePoint {
                latitude: row.latitude,
                longitude: row.longitude,
                sequence: row.shape_pt_sequence,
            });
    }

    shapes
}

fn scheduled_shapes_cache_key(stop_id: Option<&str>, limit: i32) -> String {
    match stop_id {
        Some(stop_id) => format!("stop:{stop_id}:{limit}"),
        None => format!("network:{limit}"),
    }
}

#[Object]
impl BusQuery {
    #[graphql(complexity = 10)]
    async fn bus_realtime_status(&self, ctx: &Context<'_>) -> Result<BusRealtimeStatus> {
        let pool = ctx.data::<PgPool>()?;
        let cache = ctx.data::<QueryCache>()?;
        let pool = pool.clone();

        let result = cache
            .bus_realtime_status
            .try_get_with((), async move {
                let row = sqlx::query_as::<_, BusRealtimeStatusRow>(
                    "SELECT
                        MAX(fetched_at) AT TIME ZONE 'UTC' AS last_success_at,
                        COALESCE(
                            MAX(fetched_at) >
                                (NOW() AT TIME ZONE 'UTC') - INTERVAL '3 minutes',
                            FALSE
                        ) AS is_live
                     FROM fetch_history
                     WHERE endpoint = 'nta_trip_updates'
                       AND status = 'success'",
                )
                .fetch_one(&pool)
                .await?;

                Ok::<_, sqlx::Error>(Arc::new(BusRealtimeStatus::from(row)))
            })
            .await
            .map_err(|error| Error::new(error.to_string()))?;

        Ok((*result).clone())
    }

    #[graphql(complexity = 25)]
    async fn bus_stops(
        &self,
        ctx: &Context<'_>,
        search: Option<String>,
        #[graphql(default = 50)] limit: i32,
    ) -> Result<Vec<BusStop>> {
        let pool = ctx.data::<PgPool>()?;
        let cache = ctx.data::<QueryCache>()?;
        let pattern = search_pattern(search)?;
        let limit = limit.clamp(BUS_STOPS_LIMIT.0, BUS_STOPS_LIMIT.1);
        let cache_key = format!("{}:{limit}", pattern.as_deref().unwrap_or("*"));
        let pool = pool.clone();

        let result = cache
            .bus_stops
            .try_get_with(cache_key, async move {
                let rows = sqlx::query_as::<_, BusStopRow>(
                    "SELECT
                stop.stop_id,
                NULLIF(BTRIM(stop.stop_code), '') AS stop_code,
                NULLIF(BTRIM(stop.stop_name), '') AS stop_name,
                stop.stop_lat AS latitude,
                stop.stop_lon AS longitude
             FROM bus_stops stop
             JOIN transit_feed_versions feed ON feed.id = stop.feed_version_id
             WHERE feed.is_active
               AND (
                    $1::text IS NULL
                    OR stop.stop_name ILIKE $1 ESCAPE E'\\\\'
                    OR stop.stop_code ILIKE $1 ESCAPE E'\\\\'
                    OR stop.stop_id ILIKE $1 ESCAPE E'\\\\'
               )
             ORDER BY stop.stop_name NULLS LAST, stop.stop_code NULLS LAST, stop.stop_id
             LIMIT $2",
                )
                .bind(pattern)
                .bind(i64::from(limit))
                .fetch_all(&pool)
                .await?;

                Ok::<_, sqlx::Error>(Arc::new(rows.into_iter().map(BusStop::from).collect()))
            })
            .await
            .map_err(|error| Error::new(error.to_string()))?;

        Ok((*result).clone())
    }

    #[graphql(complexity = 100)]
    async fn bus_stop_board(
        &self,
        ctx: &Context<'_>,
        stop_id: String,
        #[graphql(default = 30)] limit: i32,
    ) -> Result<Vec<BusDeparture>> {
        let pool = ctx.data::<PgPool>()?;
        let cache = ctx.data::<QueryCache>()?;
        let stop_id = validate_identifier(stop_id, "stopId")?;
        let limit = limit.clamp(BUS_STOP_BOARD_LIMIT.0, BUS_STOP_BOARD_LIMIT.1);
        let cache_key = format!("{stop_id}:{limit}");
        let pool = pool.clone();

        let result = cache.bus_stop_boards.try_get_with(cache_key, async move {
            let rows = sqlx::query_as::<_, BusDepartureRow>(
            "WITH latest AS (
                SELECT DISTINCT ON (
                    update.feed_version_id,
                    update.trip_instance_key,
                    CASE
                        WHEN update.stop_sequence IS NOT NULL
                        THEN 'sequence:' || update.stop_sequence::text
                        WHEN update.stop_id IS NOT NULL
                        THEN 'stop_id:' || update.stop_id
                        ELSE 'unknown'
                    END
                )
                    update.*,
                    freshness.last_seen_at AS trip_last_seen_at
                FROM bus_stop_updates update
                JOIN transit_feed_versions feed ON feed.id = update.feed_version_id
                JOIN bus_trip_update_freshness freshness
                    ON freshness.feed_version_id = update.feed_version_id
                   AND freshness.trip_instance_key = update.trip_instance_key
                LEFT JOIN bus_stop_times identified_stop
                    ON identified_stop.feed_version_id = update.feed_version_id
                   AND identified_stop.trip_id = update.trip_id
                   AND identified_stop.stop_sequence = update.stop_sequence
                LEFT JOIN fetch_schedules poll_schedule
                    ON poll_schedule.endpoint = 'nta_trip_updates'
                WHERE feed.is_active
                  AND COALESCE(update.stop_id, identified_stop.stop_id) = $1
                  AND UPPER(freshness.schedule_relationship) NOT IN (
                        'CANCELED', 'CANCELLED', 'DELETED'
                  )
                  AND freshness.last_seen_at > NOW() - make_interval(
                        secs => GREATEST(
                            COALESCE(poll_schedule.interval_seconds, 60) * 3,
                            180
                        )
                  )
                ORDER BY
                    update.feed_version_id,
                    update.trip_instance_key,
                    CASE
                        WHEN update.stop_sequence IS NOT NULL
                        THEN 'sequence:' || update.stop_sequence::text
                        WHEN update.stop_id IS NOT NULL
                        THEN 'stop_id:' || update.stop_id
                        ELSE 'unknown'
                    END,
                    update.last_seen_at DESC,
                    update.id DESC
             ), enriched AS (
                SELECT
                    latest.entity_id,
                    latest.trip_id,
                    COALESCE(latest.route_id, trip.route_id) AS route_id,
                    NULLIF(BTRIM(route.route_short_name), '') AS route_short_name,
                    NULLIF(BTRIM(route.route_long_name), '') AS route_long_name,
                    NULLIF(BTRIM(agency.agency_name), '') AS operator_name,
                    NULLIF(BTRIM(trip.trip_headsign), '') AS headsign,
                    latest.service_date,
                    CASE
                        WHEN latest.service_date IS NOT NULL
                             AND COALESCE(stop_time.departure_seconds, stop_time.arrival_seconds) IS NOT NULL
                        THEN (
                            latest.service_date::timestamp
                            + make_interval(
                                secs => COALESCE(
                                    stop_time.departure_seconds,
                                    stop_time.arrival_seconds
                                )
                            )
                        ) AT TIME ZONE COALESCE(
                            NULLIF(agency.agency_timezone, ''),
                            'Europe/Dublin'
                        )
                    END AS scheduled_time,
                    COALESCE(latest.departure_time, latest.arrival_time) AS realtime_time,
                    COALESCE(
                        latest.departure_delay_seconds,
                        latest.arrival_delay_seconds
                    ) AS delay_seconds,
                    NULLIF(BTRIM(latest.schedule_relationship), '') AS schedule_relationship,
                    latest.trip_last_seen_at AS fetched_at
                FROM latest
                LEFT JOIN bus_trips trip
                    ON trip.feed_version_id = latest.feed_version_id
                   AND trip.trip_id = latest.trip_id
                LEFT JOIN bus_routes route
                    ON route.feed_version_id = latest.feed_version_id
                   AND route.route_id = COALESCE(latest.route_id, trip.route_id)
                LEFT JOIN bus_agencies agency
                    ON agency.feed_version_id = route.feed_version_id
                   AND agency.agency_id = route.agency_id
                LEFT JOIN LATERAL (
                    SELECT candidate.arrival_seconds, candidate.departure_seconds
                    FROM bus_stop_times candidate
                    WHERE candidate.feed_version_id = latest.feed_version_id
                      AND candidate.trip_id = latest.trip_id
                      AND (
                          (
                              latest.stop_sequence IS NOT NULL
                              AND candidate.stop_sequence = latest.stop_sequence
                              AND (
                                  latest.stop_id IS NULL
                                  OR candidate.stop_id = latest.stop_id
                              )
                          )
                          OR (
                              latest.stop_sequence IS NULL
                              AND candidate.stop_id = latest.stop_id
                          )
                      )
                    ORDER BY candidate.stop_sequence
                    LIMIT 1
                ) stop_time ON TRUE
             ), departures AS (
             SELECT
                entity_id,
                trip_id,
                route_id,
                route_short_name,
                route_long_name,
                operator_name,
                headsign,
                service_date,
                scheduled_time,
                COALESCE(
                    realtime_time,
                    scheduled_time + make_interval(secs => delay_seconds),
                    scheduled_time
                ) AS expected_time,
                delay_seconds,
                schedule_relationship,
                fetched_at,
                COALESCE(
                    realtime_time,
                    scheduled_time + make_interval(secs => delay_seconds),
                    scheduled_time
                ) AS departure_time
             FROM enriched
             )
             SELECT
                entity_id,
                trip_id,
                route_id,
                route_short_name,
                route_long_name,
                operator_name,
                headsign,
                service_date,
                scheduled_time,
                expected_time,
                delay_seconds,
                schedule_relationship,
                fetched_at
             FROM departures
             WHERE departure_time >= NOW() - INTERVAL '5 minutes'
               AND departure_time <= NOW() + INTERVAL '4 hours'
               AND UPPER(COALESCE(schedule_relationship, '')) NOT IN (
                    'SKIPPED', 'CANCELED', 'CANCELLED', 'DELETED'
               )
             ORDER BY departure_time, fetched_at DESC
             LIMIT $2",
        )
        .bind(stop_id)
        .bind(i64::from(limit))
            .fetch_all(&pool)
            .await?;

            Ok::<_, sqlx::Error>(Arc::new(
                rows.into_iter().map(BusDeparture::from).collect(),
            ))
        })
        .await
        .map_err(|error| Error::new(error.to_string()))?;

        Ok((*result).clone())
    }

    #[graphql(complexity = 400)]
    async fn bus_vehicles(
        &self,
        ctx: &Context<'_>,
        route_id: Option<String>,
        #[graphql(default = 2000)] limit: i32,
    ) -> Result<Vec<BusVehicle>> {
        let pool = ctx.data::<PgPool>()?;
        let cache = ctx.data::<QueryCache>()?;
        let route_id = route_id
            .map(|value| validate_identifier(value, "routeId"))
            .transpose()?;
        let limit = limit.clamp(BUS_VEHICLE_LIMIT.0, BUS_VEHICLE_LIMIT.1);
        let cache_key = format!("{}:{limit}", route_id.as_deref().unwrap_or("*"));
        let pool = pool.clone();

        let result = cache
            .bus_vehicles
            .try_get_with(cache_key, async move {
                let rows = sqlx::query_as::<_, BusVehicleRow>(
                    "SELECT
                        vehicle.entity_id,
                        vehicle.vehicle_id,
                        vehicle.vehicle_label,
                        vehicle.trip_id,
                        COALESCE(vehicle.route_id, trip.route_id) AS route_id,
                        NULLIF(BTRIM(route.route_short_name), '') AS route_short_name,
                        NULLIF(BTRIM(route.route_long_name), '') AS route_long_name,
                        NULLIF(BTRIM(agency.agency_name), '') AS operator_name,
                        NULLIF(BTRIM(trip.trip_headsign), '') AS headsign,
                        vehicle.latitude,
                        vehicle.longitude,
                        vehicle.bearing,
                        vehicle.speed AS speed_meters_per_second,
                        vehicle.current_stop_sequence,
                        vehicle.stop_id,
                        vehicle.current_status,
                        vehicle.occupancy_status,
                        vehicle.source_timestamp,
                        vehicle.last_seen_at AS fetched_at
                     FROM bus_vehicle_positions vehicle
                     JOIN transit_feed_versions feed
                       ON feed.id = vehicle.feed_version_id
                      AND feed.is_active
                     LEFT JOIN bus_trips trip
                       ON trip.feed_version_id = vehicle.feed_version_id
                      AND trip.trip_id = vehicle.trip_id
                     LEFT JOIN bus_routes route
                       ON route.feed_version_id = vehicle.feed_version_id
                      AND route.route_id = COALESCE(vehicle.route_id, trip.route_id)
                     LEFT JOIN bus_agencies agency
                       ON agency.feed_version_id = route.feed_version_id
                      AND agency.agency_id = route.agency_id
                     WHERE vehicle.last_seen_at > NOW() - INTERVAL '5 minutes'
                       AND vehicle.latitude BETWEEN -90 AND 90
                       AND vehicle.longitude BETWEEN -180 AND 180
                       AND ($1::text IS NULL OR COALESCE(vehicle.route_id, trip.route_id) = $1)
                       AND UPPER(vehicle.schedule_relationship) NOT IN (
                           'CANCELED', 'CANCELLED', 'DELETED'
                       )
                     ORDER BY vehicle.last_seen_at DESC, route.route_short_name, vehicle.vehicle_instance_key
                     LIMIT $2",
                )
                .bind(route_id)
                .bind(i64::from(limit))
                .fetch_all(&pool)
                .await?;

                Ok::<_, sqlx::Error>(Arc::new(
                    rows.into_iter().map(BusVehicle::from).collect(),
                ))
            })
            .await
            .map_err(|error| Error::new(error.to_string()))?;

        Ok((*result).clone())
    }

    #[graphql(complexity = 150)]
    async fn bus_live_route_shapes(
        &self,
        ctx: &Context<'_>,
        #[graphql(default = 100)] limit: i32,
    ) -> Result<Vec<BusRouteShape>> {
        let pool = ctx.data::<PgPool>()?;
        let cache = ctx.data::<QueryCache>()?;
        let limit = limit.clamp(BUS_ROUTE_SHAPE_LIMIT.0, BUS_ROUTE_SHAPE_LIMIT.1);
        let pool = pool.clone();

        let result = cache
            .bus_live_route_shapes
            .try_get_with(limit, async move {
                let rows = sqlx::query_as::<_, BusShapePointRow>(
                    "WITH active_shapes AS (
                        SELECT
                            vehicle.feed_version_id,
                            COALESCE(vehicle.route_id, trip.route_id) AS route_id,
                            NULLIF(BTRIM(route.route_short_name), '') AS route_short_name,
                            trip.shape_id,
                            NULLIF(BTRIM(route.route_color), '') AS route_color,
                            MAX(vehicle.last_seen_at) AS last_seen_at
                        FROM bus_vehicle_positions vehicle
                        JOIN transit_feed_versions feed
                          ON feed.id = vehicle.feed_version_id
                         AND feed.is_active
                        JOIN bus_trips trip
                          ON trip.feed_version_id = vehicle.feed_version_id
                         AND trip.trip_id = vehicle.trip_id
                        LEFT JOIN bus_routes route
                          ON route.feed_version_id = vehicle.feed_version_id
                         AND route.route_id = COALESCE(vehicle.route_id, trip.route_id)
                        WHERE vehicle.last_seen_at > NOW() - INTERVAL '5 minutes'
                          AND vehicle.latitude BETWEEN -90 AND 90
                          AND vehicle.longitude BETWEEN -180 AND 180
                          AND NULLIF(BTRIM(trip.shape_id), '') IS NOT NULL
                          AND UPPER(vehicle.schedule_relationship) NOT IN (
                              'CANCELED', 'CANCELLED', 'DELETED'
                          )
                        GROUP BY
                            vehicle.feed_version_id,
                            COALESCE(vehicle.route_id, trip.route_id),
                            route.route_short_name,
                            trip.shape_id,
                            route.route_color
                        ORDER BY MAX(vehicle.last_seen_at) DESC, route_id, trip.shape_id
                        LIMIT $1
                    ), ranked_points AS (
                        SELECT
                            active.route_id,
                            active.route_short_name,
                            active.shape_id,
                            active.route_color,
                            active.last_seen_at,
                            point.shape_pt_lat AS latitude,
                            point.shape_pt_lon AS longitude,
                            point.shape_pt_sequence,
                            ROW_NUMBER() OVER (
                                PARTITION BY active.feed_version_id,
                                             active.route_id,
                                             active.shape_id
                                ORDER BY point.shape_pt_sequence
                            ) AS point_number,
                            COUNT(*) OVER (
                                PARTITION BY active.feed_version_id,
                                             active.route_id,
                                             active.shape_id
                            ) AS point_count
                        FROM active_shapes active
                        JOIN bus_shape_points point
                          ON point.feed_version_id = active.feed_version_id
                         AND point.shape_id = active.shape_id
                    )
                    SELECT
                        route_id,
                        route_short_name,
                        shape_id,
                        route_color,
                        latitude,
                        longitude,
                        shape_pt_sequence
                    FROM ranked_points
                    WHERE point_count >= 2
                      AND (
                          point_count <= $2
                          OR point_number = 1
                          OR point_number = point_count
                          OR MOD(
                              point_number - 1,
                              GREATEST(
                                  1,
                                  CEIL(
                                      (point_count - 1)::numeric / ($2 - 1)
                                  )::bigint
                              )
                          ) = 0
                      )
                    ORDER BY last_seen_at DESC, route_id, shape_id, shape_pt_sequence",
                )
                .bind(i64::from(limit))
                .bind(BUS_SHAPE_POINTS_PER_SHAPE)
                .fetch_all(&pool)
                .await?;

                Ok::<_, sqlx::Error>(Arc::new(group_bus_route_shapes(rows)))
            })
            .await
            .map_err(|error| Error::new(error.to_string()))?;

        Ok((*result).clone())
    }

    #[graphql(complexity = 150)]
    async fn bus_scheduled_route_shapes(
        &self,
        ctx: &Context<'_>,
        stop_id: Option<String>,
        #[graphql(default = 24)] limit: i32,
    ) -> Result<Vec<BusRouteShape>> {
        let pool = ctx.data::<PgPool>()?;
        let cache = ctx.data::<QueryCache>()?;
        let stop_id = stop_id
            .map(|value| validate_identifier(value, "stopId"))
            .transpose()?;
        let limit = limit.clamp(
            BUS_SCHEDULED_ROUTE_SHAPE_LIMIT.0,
            BUS_SCHEDULED_ROUTE_SHAPE_LIMIT.1,
        );
        let cache_key = scheduled_shapes_cache_key(stop_id.as_deref(), limit);
        let pool = pool.clone();

        let result = cache
            .bus_scheduled_route_shapes
            .try_get_with(cache_key, async move {
                let rows = sqlx::query_as::<_, BusShapePointRow>(
                    "WITH candidate_trips AS (
                        SELECT
                            trip.feed_version_id,
                            trip.trip_id,
                            trip.route_id,
                            trip.direction_id,
                            trip.shape_id
                        FROM transit_feed_versions feed
                        JOIN bus_trips trip ON trip.feed_version_id = feed.id
                        WHERE feed.is_active
                          AND $1::text IS NULL
                          AND NULLIF(BTRIM(trip.shape_id), '') IS NOT NULL

                        UNION ALL

                        SELECT
                            trip.feed_version_id,
                            trip.trip_id,
                            trip.route_id,
                            trip.direction_id,
                            trip.shape_id
                        FROM transit_feed_versions feed
                        JOIN LATERAL (
                            SELECT DISTINCT stop_time.trip_id
                            FROM bus_stop_times stop_time
                            WHERE stop_time.feed_version_id = feed.id
                              AND stop_time.stop_id = $1
                        ) serving_trip ON TRUE
                        JOIN bus_trips trip
                          ON trip.feed_version_id = feed.id
                         AND trip.trip_id = serving_trip.trip_id
                        WHERE feed.is_active
                          AND $1::text IS NOT NULL
                          AND NULLIF(BTRIM(trip.shape_id), '') IS NOT NULL
                    ), shape_usage AS (
                        SELECT
                            candidate.feed_version_id,
                            candidate.route_id,
                            candidate.direction_id,
                            candidate.shape_id,
                            NULLIF(BTRIM(route.route_short_name), '') AS route_short_name,
                            NULLIF(BTRIM(route.route_color), '') AS route_color,
                            COUNT(*) AS trip_count
                        FROM candidate_trips candidate
                        JOIN bus_routes route
                          ON route.feed_version_id = candidate.feed_version_id
                         AND route.route_id = candidate.route_id
                        GROUP BY
                            candidate.feed_version_id,
                            candidate.route_id,
                            candidate.direction_id,
                            candidate.shape_id,
                            route.route_short_name,
                            route.route_color
                    ), representative_shapes AS (
                        SELECT
                            usage.*,
                            ROW_NUMBER() OVER (
                                PARTITION BY usage.feed_version_id,
                                             usage.route_id,
                                             COALESCE(usage.direction_id, -1)
                                ORDER BY usage.trip_count DESC, usage.shape_id
                            ) AS shape_rank
                        FROM shape_usage usage
                    ), selected_shapes AS (
                        SELECT
                            feed_version_id,
                            route_id,
                            route_short_name,
                            shape_id,
                            route_color,
                            trip_count
                        FROM representative_shapes
                        WHERE shape_rank = 1
                        ORDER BY
                            trip_count DESC,
                            route_short_name NULLS LAST,
                            route_id,
                            direction_id NULLS LAST,
                            shape_id
                        LIMIT $2
                    ), ranked_points AS (
                        SELECT
                            selected.route_id,
                            selected.route_short_name,
                            selected.shape_id,
                            selected.route_color,
                            selected.trip_count,
                            point.shape_pt_lat AS latitude,
                            point.shape_pt_lon AS longitude,
                            point.shape_pt_sequence,
                            ROW_NUMBER() OVER (
                                PARTITION BY selected.feed_version_id,
                                             selected.route_id,
                                             selected.shape_id
                                ORDER BY point.shape_pt_sequence
                            ) AS point_number,
                            COUNT(*) OVER (
                                PARTITION BY selected.feed_version_id,
                                             selected.route_id,
                                             selected.shape_id
                            ) AS point_count
                        FROM selected_shapes selected
                        JOIN bus_shape_points point
                          ON point.feed_version_id = selected.feed_version_id
                         AND point.shape_id = selected.shape_id
                    )
                    SELECT
                        route_id,
                        route_short_name,
                        shape_id,
                        route_color,
                        latitude,
                        longitude,
                        shape_pt_sequence
                    FROM ranked_points
                    WHERE point_count >= 2
                      AND (
                          point_count <= $3
                          OR point_number = 1
                          OR point_number = point_count
                          OR MOD(
                              point_number - 1,
                              GREATEST(
                                  1,
                                  CEIL(
                                      (point_count - 1)::numeric / ($3 - 1)
                                  )::bigint
                              )
                          ) = 0
                      )
                    ORDER BY
                        trip_count DESC,
                        route_short_name NULLS LAST,
                        route_id,
                        shape_id,
                        shape_pt_sequence",
                )
                .bind(stop_id)
                .bind(i64::from(limit))
                .bind(BUS_SCHEDULED_SHAPE_POINTS_PER_SHAPE)
                .fetch_all(&pool)
                .await?;

                Ok::<_, sqlx::Error>(Arc::new(group_bus_route_shapes(rows)))
            })
            .await
            .map_err(|error| Error::new(error.to_string()))?;

        Ok((*result).clone())
    }

    #[graphql(complexity = 300)]
    async fn bus_route_delays(
        &self,
        ctx: &Context<'_>,
        #[graphql(default = 24)] hours: i32,
        #[graphql(default = 30)] limit: i32,
    ) -> Result<Vec<BusRouteDelay>> {
        let pool = ctx.data::<PgPool>()?;
        let cache = ctx.data::<QueryCache>()?;
        let hours = bus_route_delay_hours(ctx, hours);
        let limit = limit.clamp(BUS_ROUTE_DELAY_LIMIT.0, BUS_ROUTE_DELAY_LIMIT.1);
        let cache_key = format!("{hours}:{limit}");
        let pool = pool.clone();

        let result = cache
            .bus_route_delays
            .try_get_with(cache_key, async move {
                let rows = sqlx::query_as::<_, BusRouteDelayRow>(
                    "WITH candidates AS (
                SELECT
                    update.id,
                    update.feed_version_id,
                    update.trip_instance_key,
                    update.entity_id,
                    update.trip_id,
                    update.service_date,
                    update.stop_id,
                    update.stop_sequence,
                    COALESCE(update.route_id, trip.route_id) AS route_id,
                    COALESCE(
                        update.departure_delay_seconds,
                        update.arrival_delay_seconds
                    ) AS delay_seconds,
                    update.last_seen_at AS state_changed_at,
                    freshness.last_seen_at AS fetched_at
                FROM bus_stop_updates update
                JOIN bus_trip_update_freshness freshness
                    ON freshness.feed_version_id = update.feed_version_id
                   AND freshness.trip_instance_key = update.trip_instance_key
                LEFT JOIN bus_trips trip
                    ON trip.feed_version_id = update.feed_version_id
                   AND trip.trip_id = update.trip_id
                WHERE freshness.last_seen_at > NOW() - make_interval(hours => $1)
                  AND UPPER(freshness.schedule_relationship) NOT IN (
                        'CANCELED', 'CANCELLED', 'DELETED'
                  )
                  AND COALESCE(
                        update.departure_delay_seconds,
                        update.arrival_delay_seconds
                      ) IS NOT NULL
             ), latest AS (
                SELECT DISTINCT ON (
                    feed_version_id,
                    trip_instance_key,
                    CASE
                        WHEN stop_sequence IS NOT NULL
                        THEN 'sequence:' || stop_sequence::text
                        WHEN stop_id IS NOT NULL
                        THEN 'stop_id:' || stop_id
                        ELSE 'unknown'
                    END
                )
                    feed_version_id,
                    route_id,
                    delay_seconds,
                    fetched_at,
                    state_changed_at
                FROM candidates
                WHERE route_id IS NOT NULL
                ORDER BY
                    feed_version_id,
                    trip_instance_key,
                    CASE
                        WHEN stop_sequence IS NOT NULL
                        THEN 'sequence:' || stop_sequence::text
                        WHEN stop_id IS NOT NULL
                        THEN 'stop_id:' || stop_id
                        ELSE 'unknown'
                    END,
                    state_changed_at DESC,
                    id DESC
             ), aggregated AS (
                SELECT
                    feed_version_id,
                    route_id,
                    AVG(delay_seconds)::float8 AS avg_delay_seconds,
                    (
                        COUNT(*) FILTER (WHERE delay_seconds <= 300)
                        * 100.0
                        / NULLIF(COUNT(*), 0)
                    )::float8 AS on_time_pct,
                    COUNT(*)::int8 AS sample_count,
                    MAX(fetched_at) AS last_updated
                FROM latest
                GROUP BY feed_version_id, route_id
             )
             SELECT
                aggregated.route_id,
                metadata.route_short_name,
                metadata.route_long_name,
                metadata.operator_name,
                aggregated.avg_delay_seconds,
                aggregated.on_time_pct,
                aggregated.sample_count,
                aggregated.last_updated
             FROM aggregated
             LEFT JOIN LATERAL (
                SELECT
                    NULLIF(BTRIM(route.route_short_name), '') AS route_short_name,
                    NULLIF(BTRIM(route.route_long_name), '') AS route_long_name,
                    NULLIF(BTRIM(agency.agency_name), '') AS operator_name
                FROM bus_routes route
                JOIN transit_feed_versions feed
                    ON feed.id = route.feed_version_id
                LEFT JOIN bus_agencies agency
                    ON agency.feed_version_id = route.feed_version_id
                   AND agency.agency_id = route.agency_id
                WHERE route.feed_version_id = aggregated.feed_version_id
                  AND route.route_id = aggregated.route_id
                LIMIT 1
             ) metadata ON TRUE
             ORDER BY
                aggregated.avg_delay_seconds DESC,
                aggregated.sample_count DESC,
                aggregated.route_id
             LIMIT $2",
                )
                .bind(hours)
                .bind(i64::from(limit))
                .fetch_all(&pool)
                .await?;

                Ok::<_, sqlx::Error>(Arc::new(
                    rows.into_iter().map(BusRouteDelay::from).collect(),
                ))
            })
            .await
            .map_err(|error| Error::new(error.to_string()))?;

        Ok((*result).clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{TimeZone, Utc};

    #[test]
    fn validates_and_trims_stop_ids() {
        assert_eq!(
            validate_identifier(" 8220DB000001 ".into(), "stopId").unwrap(),
            "8220DB000001"
        );
        assert!(validate_identifier("   ".into(), "stopId").is_err());
        assert!(validate_identifier("x".repeat(256), "stopId").is_err());
    }

    #[test]
    fn escapes_search_wildcards() {
        assert_eq!(search_pattern(None).unwrap(), None);
        assert_eq!(search_pattern(Some("  ".into())).unwrap(), None);
        assert_eq!(
            search_pattern(Some(r"50%_\stop".into())).unwrap(),
            Some(r"%50\%\_\\stop%".into())
        );
        assert!(search_pattern(Some("x".repeat(101))).is_err());
    }

    #[test]
    fn public_bus_history_is_bounded_below_paid_history() {
        assert_eq!(max_bus_route_delay_hours(None), 72);
        assert_eq!(max_bus_route_delay_hours(Some("free")), 72);
        assert_eq!(max_bus_route_delay_hours(Some("coffee")), 168);
        assert_eq!(max_bus_route_delay_hours(Some("pro")), 168);
        assert_eq!(max_bus_route_delay_hours(Some("admin")), 168);
    }

    #[test]
    fn scheduled_shape_cache_keys_separate_network_and_literal_stop_ids() {
        assert_eq!(scheduled_shapes_cache_key(None, 24), "network:24");
        assert_eq!(scheduled_shapes_cache_key(Some("*"), 24), "stop:*:24");
    }

    #[test]
    fn groups_ordered_shape_points_without_repeating_route_metadata() {
        let rows = vec![
            BusShapePointRow {
                route_id: "404".into(),
                route_short_name: Some("404".into()),
                shape_id: "outbound".into(),
                route_color: Some("0B6B4D".into()),
                latitude: 53.0,
                longitude: -9.0,
                shape_pt_sequence: 0,
            },
            BusShapePointRow {
                route_id: "404".into(),
                route_short_name: Some("404".into()),
                shape_id: "outbound".into(),
                route_color: Some("0B6B4D".into()),
                latitude: 53.1,
                longitude: -8.9,
                shape_pt_sequence: 4,
            },
            BusShapePointRow {
                route_id: "409".into(),
                route_short_name: None,
                shape_id: "inbound".into(),
                route_color: None,
                latitude: 53.2,
                longitude: -8.8,
                shape_pt_sequence: 2,
            },
        ];

        let shapes = group_bus_route_shapes(rows);

        assert_eq!(shapes.len(), 2);
        assert_eq!(shapes[0].route_id, "404");
        assert_eq!(shapes[0].route_short_name.as_deref(), Some("404"));
        assert_eq!(shapes[0].route_color.as_deref(), Some("0B6B4D"));
        assert_eq!(shapes[0].points.len(), 2);
        assert_eq!(shapes[0].points[1].sequence, 4);
        assert_eq!(shapes[1].shape_id, "inbound");
        assert_eq!(shapes[1].points[0].longitude, -8.8);
    }

    #[test]
    fn realtime_status_serializes_the_last_success_in_utc() {
        let status = BusRealtimeStatus::from(BusRealtimeStatusRow {
            last_success_at: Some(Utc.with_ymd_and_hms(2026, 9, 13, 12, 45, 0).unwrap()),
            is_live: true,
        });

        assert!(status.is_live);
        assert_eq!(
            status.last_success_at.as_deref(),
            Some("2026-09-13T12:45:00Z")
        );
    }
}
