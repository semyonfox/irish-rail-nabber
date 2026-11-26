use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use async_graphql::{Context, Error, Object, Result, SimpleObject};
use chrono::{DateTime, Utc};
use sqlx::PgPool;

use super::types::{BusRouteShape, BusShapePoint};
use crate::geometry::{simplify, LatLon, RouteLine};
use crate::state::QueryCache;

const LIVE_SHAPE_LIMIT: (i32, i32) = (1, 2_000);
// a few metres is invisible at street zoom and drops about nine in ten points
const SHAPE_TOLERANCE_M: f64 = 8.0;
// further than this from its own shape, a bus is diverted or mis-tagged
const MAX_ROUTE_OFFSET_M: f64 = 150.0;
// buses lay over together at a terminus on purpose
const TERMINUS_MARGIN_M: f64 = 600.0;
const BUNCHED_WITHIN_M: f64 = 400.0;
// two buses closer than this are parked nose to tail at a stand, a moving
// pair is rarely this tight. in November 2026 the pairs under 15 m were all
// heading into Sandyford garage, Heuston or Ballinteer, past the margin above
const STACKED_WITHIN_M: f64 = 25.0;
const MIN_SCHEDULED_GAP_SECONDS: i32 = 6 * 60;
// a pair timetabled further apart means one bus is very late or is reporting
// the wrong trip. bunching is a problem of frequent routes anyway
const MAX_SCHEDULED_GAP_SECONDS: i32 = 30 * 60;
// positions further apart in time than one vehicles poll aren't comparable
const MAX_REPORT_SKEW_SECONDS: i64 = 90;

/// (feed version, shape id)
pub type ShapeKey = (i64, String);

#[derive(Default)]
pub struct BusLiveQuery;

#[derive(Clone, SimpleObject)]
pub struct BusBunch {
    pub route_id: String,
    pub route_short_name: Option<String>,
    pub headsign: Option<String>,
    /// trips in order along the route, matching `BusVehicle.tripId`
    pub trip_ids: Vec<String>,
    /// distance along the route from the first bus to the last
    pub spread_metres: i32,
    /// smallest timetabled gap between neighbouring buses in the group
    pub scheduled_gap_minutes: i32,
}

#[derive(Clone, SimpleObject)]
pub struct BusServiceNotice {
    pub notice_id: String,
    pub header: String,
    pub description: String,
    pub url: Option<String>,
    pub category: String,
    pub effect: Option<String>,
    pub starts_at: Option<String>,
    pub ends_at: Option<String>,
    /// route ids from the feed the notice arrived with
    pub route_ids: Vec<String>,
    pub route_short_names: Vec<String>,
    pub stop_count: i32,
}

#[derive(sqlx::FromRow)]
struct ActiveShapeRow {
    feed_version_id: i64,
    route_id: String,
    route_short_name: Option<String>,
    shape_id: String,
    route_color: Option<String>,
}

#[derive(sqlx::FromRow, Clone)]
pub struct RunningVehicle {
    pub feed_version_id: i64,
    pub trip_id: String,
    pub route_id: String,
    pub route_short_name: Option<String>,
    pub headsign: Option<String>,
    pub shape_id: String,
    pub latitude: f64,
    pub longitude: f64,
    pub start_seconds: i32,
    pub reported_at: DateTime<Utc>,
}

#[derive(sqlx::FromRow)]
struct NoticeRow {
    alert_key: String,
    header: String,
    description: String,
    url: Option<String>,
    category: String,
    effect: Option<String>,
    starts_at: Option<DateTime<Utc>>,
    ends_at: Option<DateTime<Utc>>,
    route_ids: Vec<String>,
    route_short_names: Vec<String>,
    stop_count: i32,
}

fn valid_point(latitude: f64, longitude: f64) -> bool {
    latitude.is_finite()
        && longitude.is_finite()
        && (-90.0..=90.0).contains(&latitude)
        && (-180.0..=180.0).contains(&longitude)
}

/// simplified shape geometry. shapes never change within a feed version, so
/// only shapes not seen before go to the database
pub async fn shape_geometry(
    pool: &PgPool,
    cache: &QueryCache,
    keys: &[ShapeKey],
) -> Result<HashMap<ShapeKey, Arc<Vec<LatLon>>>, sqlx::Error> {
    let mut found = HashMap::new();
    let mut missing: HashMap<i64, HashSet<String>> = HashMap::new();
    for key in keys {
        if found.contains_key(key) {
            continue;
        }
        match cache.bus_shape_geometry.get(key).await {
            Some(points) => {
                found.insert(key.clone(), points);
            }
            None => {
                missing.entry(key.0).or_default().insert(key.1.clone());
            }
        }
    }

    for (feed_version_id, shape_ids) in missing {
        let shape_ids: Vec<String> = shape_ids.into_iter().collect();
        let rows = sqlx::query_as::<_, (String, f64, f64)>(
            "SELECT shape_id, shape_pt_lat, shape_pt_lon
             FROM bus_shape_points
             WHERE feed_version_id = $1 AND shape_id = ANY($2)
             ORDER BY shape_id, shape_pt_sequence",
        )
        .bind(feed_version_id)
        .bind(&shape_ids)
        .fetch_all(pool)
        .await?;

        let mut shapes: Vec<(String, Vec<LatLon>)> = Vec::new();
        for (shape_id, latitude, longitude) in rows {
            if !valid_point(latitude, longitude) {
                continue;
            }
            match shapes.last_mut() {
                Some((current, points)) if *current == shape_id => {
                    points.push((latitude, longitude))
                }
                _ => shapes.push((shape_id, vec![(latitude, longitude)])),
            }
        }
        for (shape_id, points) in shapes {
            let key = (feed_version_id, shape_id);
            let points = Arc::new(simplify(&points, SHAPE_TOLERANCE_M));
            cache
                .bus_shape_geometry
                .insert(key.clone(), points.clone())
                .await;
            found.insert(key, points);
        }
    }

    Ok(found)
}

pub fn find_bunches(
    vehicles: &[RunningVehicle],
    geometry: &HashMap<ShapeKey, Arc<Vec<LatLon>>>,
) -> Vec<BusBunch> {
    let mut by_shape: HashMap<ShapeKey, Vec<&RunningVehicle>> = HashMap::new();
    for vehicle in vehicles {
        by_shape
            .entry((vehicle.feed_version_id, vehicle.shape_id.clone()))
            .or_default()
            .push(vehicle);
    }

    let mut bunches = Vec::new();
    for (key, group) in by_shape {
        if group.len() < 2 {
            continue;
        }
        let Some(line) = geometry.get(&key).and_then(|points| RouteLine::new(points)) else {
            continue;
        };
        let length = line.length_m();
        let mut placed: Vec<(f64, &RunningVehicle)> = group
            .into_iter()
            .filter_map(|vehicle| {
                let projection = line.project((vehicle.latitude, vehicle.longitude));
                let mid_route = projection.along_m >= TERMINUS_MARGIN_M
                    && projection.along_m <= length - TERMINUS_MARGIN_M;
                (projection.offset_m <= MAX_ROUTE_OFFSET_M && mid_route)
                    .then_some((projection.along_m, vehicle))
            })
            .collect();
        placed.sort_by(|left, right| left.0.total_cmp(&right.0));

        let mut run: Vec<(f64, &RunningVehicle)> = Vec::new();
        let mut run_gap = i32::MAX;
        let mut flush = |run: &mut Vec<(f64, &RunningVehicle)>, gap: &mut i32| {
            if run.len() >= 2 {
                let first = run[0];
                bunches.push(BusBunch {
                    route_id: first.1.route_id.clone(),
                    route_short_name: first.1.route_short_name.clone(),
                    headsign: first.1.headsign.clone(),
                    trip_ids: run
                        .iter()
                        .map(|(_, vehicle)| vehicle.trip_id.clone())
                        .collect(),
                    spread_metres: (run[run.len() - 1].0 - first.0).round() as i32,
                    scheduled_gap_minutes: *gap / 60,
                });
            }
            run.clear();
            *gap = i32::MAX;
        };
        for pair in placed.windows(2) {
            let (behind, ahead) = (pair[0], pair[1]);
            let scheduled_gap = (ahead.1.start_seconds - behind.1.start_seconds).abs();
            let skew = (ahead.1.reported_at - behind.1.reported_at)
                .num_seconds()
                .abs();
            let separation = ahead.0 - behind.0;
            let bunched = separation <= BUNCHED_WITHIN_M
                && separation >= STACKED_WITHIN_M
                && (MIN_SCHEDULED_GAP_SECONDS..=MAX_SCHEDULED_GAP_SECONDS).contains(&scheduled_gap)
                && skew <= MAX_REPORT_SKEW_SECONDS;
            if bunched {
                if run.is_empty() {
                    run.push(behind);
                }
                run.push(ahead);
                run_gap = run_gap.min(scheduled_gap);
            } else {
                flush(&mut run, &mut run_gap);
            }
        }
        flush(&mut run, &mut run_gap);
    }

    bunches.sort_by(|left, right| {
        right
            .trip_ids
            .len()
            .cmp(&left.trip_ids.len())
            .then(right.scheduled_gap_minutes.cmp(&left.scheduled_gap_minutes))
            .then(left.route_short_name.cmp(&right.route_short_name))
            .then(left.route_id.cmp(&right.route_id))
            .then(left.trip_ids.cmp(&right.trip_ids))
    });
    bunches
}

fn to_shape(row: ActiveShapeRow, points: &[LatLon]) -> BusRouteShape {
    BusRouteShape {
        route_id: row.route_id,
        route_short_name: row.route_short_name,
        shape_id: row.shape_id,
        route_color: row.route_color,
        points: points
            .iter()
            .enumerate()
            .map(|(index, &(latitude, longitude))| BusShapePoint {
                latitude,
                longitude,
                sequence: index as i64,
            })
            .collect(),
    }
}

#[Object]
impl BusLiveQuery {
    /// one simplified line per shape in use by a bus seen in the last five
    /// minutes, busiest first
    #[graphql(complexity = 150)]
    async fn bus_live_route_shapes(
        &self,
        ctx: &Context<'_>,
        #[graphql(default = 100)] limit: i32,
    ) -> Result<Vec<BusRouteShape>> {
        let pool = ctx.data::<PgPool>()?.clone();
        let cache = ctx.data::<QueryCache>()?.clone();
        let limit = limit.clamp(LIVE_SHAPE_LIMIT.0, LIVE_SHAPE_LIMIT.1);

        let result = cache
            .bus_live_route_shapes
            .clone()
            .try_get_with(limit, async move {
                let active = sqlx::query_as::<_, ActiveShapeRow>(
                    "SELECT
                        vehicle.feed_version_id,
                        trip.route_id,
                        NULLIF(BTRIM(route.route_short_name), '') AS route_short_name,
                        trip.shape_id,
                        NULLIF(BTRIM(route.route_color), '') AS route_color
                     FROM bus_vehicle_positions vehicle
                     JOIN transit_feed_versions feed
                       ON feed.id = vehicle.feed_version_id
                      AND feed.is_active
                     JOIN bus_trips trip
                       ON trip.feed_version_id = vehicle.feed_version_id
                      AND trip.trip_id = vehicle.trip_id
                     LEFT JOIN bus_routes route
                       ON route.feed_version_id = trip.feed_version_id
                      AND route.route_id = trip.route_id
                     WHERE vehicle.last_seen_at > NOW() - INTERVAL '5 minutes'
                       AND NULLIF(BTRIM(trip.shape_id), '') IS NOT NULL
                       AND UPPER(vehicle.schedule_relationship) NOT IN (
                           'CANCELED', 'CANCELLED', 'DELETED'
                       )
                     GROUP BY 1, 2, 3, 4, 5
                     ORDER BY COUNT(*) DESC, trip.route_id, trip.shape_id
                     LIMIT $1",
                )
                .bind(i64::from(limit))
                .fetch_all(&pool)
                .await?;

                let keys: Vec<ShapeKey> = active
                    .iter()
                    .map(|row| (row.feed_version_id, row.shape_id.clone()))
                    .collect();
                let geometry = shape_geometry(&pool, &cache, &keys).await?;
                let shapes = active
                    .into_iter()
                    .filter_map(|row| {
                        let points = geometry.get(&(row.feed_version_id, row.shape_id.clone()))?;
                        (points.len() >= 2).then(|| to_shape(row, points))
                    })
                    .collect();
                Ok::<_, sqlx::Error>(Arc::new(shapes))
            })
            .await
            .map_err(|error| Error::new(error.to_string()))?;

        Ok((*result).clone())
    }

    /// buses on the same route and direction running together although the
    /// timetable spaces them at least six minutes apart
    #[graphql(complexity = 50)]
    async fn bus_bunching(&self, ctx: &Context<'_>) -> Result<Vec<BusBunch>> {
        let pool = ctx.data::<PgPool>()?.clone();
        let cache = ctx.data::<QueryCache>()?.clone();

        let result = cache
            .bus_bunching
            .clone()
            .try_get_with((), async move {
                let vehicles = sqlx::query_as::<_, RunningVehicle>(
                    "SELECT
                        vehicle.feed_version_id,
                        trip.trip_id,
                        trip.route_id,
                        NULLIF(BTRIM(route.route_short_name), '') AS route_short_name,
                        NULLIF(BTRIM(trip.trip_headsign), '') AS headsign,
                        trip.shape_id,
                        vehicle.latitude,
                        vehicle.longitude,
                        timing.start_seconds,
                        COALESCE(vehicle.source_timestamp, vehicle.last_seen_at) AS reported_at
                     FROM bus_vehicle_positions vehicle
                     JOIN transit_feed_versions feed
                       ON feed.id = vehicle.feed_version_id
                      AND feed.is_active
                     JOIN bus_trips trip
                       ON trip.feed_version_id = vehicle.feed_version_id
                      AND trip.trip_id = vehicle.trip_id
                     LEFT JOIN bus_routes route
                       ON route.feed_version_id = trip.feed_version_id
                      AND route.route_id = trip.route_id
                     JOIN LATERAL (
                         SELECT
                             MIN(COALESCE(stop_time.departure_seconds, stop_time.arrival_seconds))
                                 AS start_seconds,
                             MAX(COALESCE(stop_time.arrival_seconds, stop_time.departure_seconds))
                                 AS end_seconds
                         FROM bus_stop_times stop_time
                         WHERE stop_time.feed_version_id = trip.feed_version_id
                           AND stop_time.trip_id = trip.trip_id
                     ) timing ON timing.start_seconds IS NOT NULL
                     WHERE vehicle.last_seen_at > NOW() - INTERVAL '5 minutes'
                       -- buses keep reporting a finished trip while they lay
                       -- over or return to the depot, so only trips the
                       -- timetable has running now, allowing 45 minutes late
                       AND EXTRACT(EPOCH FROM NOW() - (
                           COALESCE(
                               vehicle.service_date,
                               (NOW() AT TIME ZONE 'Europe/Dublin')::date
                           )::timestamp AT TIME ZONE 'Europe/Dublin'
                       )) BETWEEN timing.start_seconds - 600 AND timing.end_seconds + 2700
                       AND vehicle.latitude BETWEEN -90 AND 90
                       AND vehicle.longitude BETWEEN -180 AND 180
                       AND NULLIF(BTRIM(trip.shape_id), '') IS NOT NULL
                       AND UPPER(vehicle.schedule_relationship) NOT IN (
                           'CANCELED', 'CANCELLED', 'DELETED'
                       )",
                )
                .fetch_all(&pool)
                .await?;

                let keys: Vec<ShapeKey> = vehicles
                    .iter()
                    .map(|vehicle| (vehicle.feed_version_id, vehicle.shape_id.clone()))
                    .collect();
                let geometry = shape_geometry(&pool, &cache, &keys).await?;
                Ok::<_, sqlx::Error>(Arc::new(find_bunches(&vehicles, &geometry)))
            })
            .await
            .map_err(|error| Error::new(error.to_string()))?;

        Ok((*result).clone())
    }

    /// NTA bus notices in effect now. the feed only carries live notices, so
    /// one missed alerts poll is tolerated before a notice drops off
    #[graphql(complexity = 50)]
    async fn bus_service_notices(&self, ctx: &Context<'_>) -> Result<Vec<BusServiceNotice>> {
        let pool = ctx.data::<PgPool>()?.clone();
        let cache = ctx.data::<QueryCache>()?;

        let result = cache
            .bus_service_notices
            .try_get_with((), async move {
                let rows = sqlx::query_as::<_, NoticeRow>(
                    "SELECT
                        alert.alert_key,
                        alert.header,
                        alert.description,
                        NULLIF(BTRIM(alert.url), '') AS url,
                        alert.category,
                        NULLIF(BTRIM(alert.effect), '') AS effect,
                        alert.starts_at,
                        alert.ends_at,
                        alert.route_ids,
                        ARRAY(
                            SELECT DISTINCT COALESCE(
                                NULLIF(BTRIM(route.route_short_name), ''),
                                route.route_id
                            )
                            FROM bus_routes route
                            WHERE route.feed_version_id = alert.feed_version_id
                              AND route.route_id = ANY(alert.route_ids)
                            ORDER BY 1
                        ) AS route_short_names,
                        CARDINALITY(alert.stop_ids) AS stop_count
                     FROM bus_service_alerts alert
                     WHERE alert.last_seen > NOW() - INTERVAL '25 minutes'
                       AND (alert.starts_at IS NULL OR alert.starts_at <= NOW())
                       AND (alert.ends_at IS NULL OR alert.ends_at > NOW())
                       -- the alerts feed also carries rail and Luas notices
                       AND NOT EXISTS (
                           SELECT 1
                           FROM UNNEST(alert.agency_ids) AS informed(agency_id)
                           WHERE NOT EXISTS (
                               SELECT 1 FROM bus_agencies agency
                               WHERE agency.feed_version_id = alert.feed_version_id
                                 AND agency.agency_id = informed.agency_id
                           )
                       )
                       AND (
                           CARDINALITY(alert.agency_ids) > 0
                           OR EXISTS (
                               SELECT 1 FROM bus_routes route
                               WHERE route.feed_version_id = alert.feed_version_id
                                 AND route.route_id = ANY(alert.route_ids)
                           )
                           OR EXISTS (
                               SELECT 1 FROM bus_stops stop
                               WHERE stop.feed_version_id = alert.feed_version_id
                                 AND stop.stop_id = ANY(alert.stop_ids)
                           )
                       )
                     ORDER BY
                        CASE alert.category
                            WHEN 'disruption' THEN 0
                            WHEN 'diversion' THEN 1
                            WHEN 'delay' THEN 2
                            ELSE 3
                        END,
                        alert.starts_at DESC NULLS LAST,
                        alert.alert_key",
                )
                .fetch_all(&pool)
                .await?;

                Ok::<_, sqlx::Error>(Arc::new(
                    rows.into_iter()
                        .map(|row| BusServiceNotice {
                            notice_id: row.alert_key,
                            header: row.header,
                            description: row.description,
                            url: row.url,
                            category: row.category,
                            effect: row.effect,
                            starts_at: row.starts_at.map(|value| value.to_rfc3339()),
                            ends_at: row.ends_at.map(|value| value.to_rfc3339()),
                            route_ids: row.route_ids,
                            route_short_names: row.route_short_names,
                            stop_count: row.stop_count,
                        })
                        .collect(),
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

    fn vehicle(trip_id: &str, latitude: f64, start_minutes: i32) -> RunningVehicle {
        RunningVehicle {
            feed_version_id: 1,
            trip_id: trip_id.into(),
            route_id: "39A".into(),
            route_short_name: Some("39A".into()),
            headsign: Some("UCD".into()),
            shape_id: "out".into(),
            latitude,
            longitude: -6.3,
            start_seconds: start_minutes * 60,
            reported_at: DateTime::from_timestamp(1_800_000_000, 0).unwrap(),
        }
    }

    // a straight 10 km route north from 53.30, about 111 m per 0.001 degrees
    fn route() -> HashMap<ShapeKey, Arc<Vec<LatLon>>> {
        HashMap::from([(
            (1, "out".to_string()),
            Arc::new(vec![(53.30, -6.3), (53.39, -6.3)]),
        )])
    }

    #[tokio::test]
    async fn dashboard_live_bus_queries_match_the_schema() {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgresql://localhost/bus_schema_validation")
            .unwrap();
        let schema = crate::schema::build_schema(pool, QueryCache::new());
        // skipped fields are still validated against the schema without a database
        let response = schema
            .execute(
                r#"query {
                    busServiceNotices @skip(if: true) {
                        noticeId header description url category startsAt endsAt
                        routeIds routeShortNames stopCount
                    }
                    busBunching @skip(if: true) {
                        routeId routeShortName headsign tripIds spreadMetres scheduledGapMinutes
                    }
                    busLiveRouteShapes(limit: 2000) @skip(if: true) {
                        routeId routeShortName shapeId routeColor polyline
                    }
                    busScheduledRouteShapes(limit: 24) @skip(if: true) {
                        routeId routeShortName shapeId routeColor polyline
                    }
                }"#,
            )
            .await;
        assert!(response.errors.is_empty(), "{:?}", response.errors);
    }

    #[test]
    fn groups_buses_running_together_despite_a_timetable_gap() {
        let vehicles = [
            vehicle("a", 53.340, 600),
            vehicle("b", 53.3415, 612),
            vehicle("c", 53.3430, 624),
            vehicle("d", 53.360, 636),
        ];
        let bunches = find_bunches(&vehicles, &route());
        assert_eq!(bunches.len(), 1);
        assert_eq!(bunches[0].trip_ids, ["a", "b", "c"]);
        assert_eq!(bunches[0].scheduled_gap_minutes, 12);
        assert!((bunches[0].spread_metres - 334).abs() <= 2);
    }

    #[test]
    fn ignores_layovers_stacked_or_stale_buses_and_timetable_gaps_out_of_range() {
        let mut stale = vehicle("stale", 53.3505, 700);
        stale.reported_at -= chrono::Duration::minutes(3);
        let mut diverted = vehicle("diverted", 53.3705, 700);
        diverted.longitude = -6.31;
        let vehicles = [
            // laying over at the first stop
            vehicle("layover-1", 53.3001, 600),
            vehicle("layover-2", 53.3002, 620),
            // timetabled two minutes apart
            vehicle("close-1", 53.320, 600),
            vehicle("close-2", 53.321, 602),
            vehicle("fresh", 53.350, 600),
            stale,
            vehicle("on-route", 53.370, 600),
            diverted,
            // parked nose to tail, about 11 m apart
            vehicle("stand-1", 53.3300, 600),
            vehicle("stand-2", 53.3301, 620),
            // timetabled 40 minutes apart
            vehicle("late-1", 53.3800, 600),
            vehicle("late-2", 53.3810, 640),
        ];
        assert!(find_bunches(&vehicles, &route()).is_empty());
    }
}
