use async_graphql::{Context, Enum, Error, Object, Result, SimpleObject};
use chrono::{DateTime, Duration, Utc};
use sqlx::{FromRow, PgPool, Postgres, Transaction};
use std::sync::Arc;

use super::bus::{search_pattern, validate_identifier};
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

#[derive(Clone, SimpleObject, FromRow)]
pub struct BusRoute {
    pub feed_version_id: i64,
    pub route_id: String,
    pub route_short_name: Option<String>,
    pub route_long_name: Option<String>,
    pub operator_name: Option<String>,
    pub is_active: bool,
}

#[derive(Clone, SimpleObject, FromRow)]
pub struct BusStopStats {
    pub feed_version_id: i64,
    pub stop_id: String,
    pub stop_name: String,
    pub avg_delay_seconds: f64,
    pub p95_delay_seconds: f64,
    pub max_delay_seconds: i32,
    pub on_time_pct: f64,
    pub sample_count: i64,
}

#[derive(Clone, SimpleObject, FromRow)]
pub struct BusJourney {
    pub feed_version_id: i64,
    pub trip_instance_key: String,
    pub trip_id: Option<String>,
    pub route_id: Option<String>,
    pub headsign: Option<String>,
    pub first_observed: String,
    pub last_observed: String,
    pub stop_count: i64,
}

#[derive(Clone, SimpleObject, FromRow)]
pub struct BusRouteStopDelay {
    pub trip_id: Option<String>,
    pub trip_instance_key: String,
    pub stop_id: Option<String>,
    pub stop_name: Option<String>,
    pub stop_sequence: Option<i32>,
    pub headsign: Option<String>,
    pub delay_seconds: Option<i32>,
    pub expected_time: Option<String>,
    pub schedule_relationship: Option<String>,
    pub last_updated: String,
}

const PUBLIC_HISTORY_MAX_HOURS: i32 = 72;
const HOURLY_RESOLUTION_MAX_HOURS: i32 = 168;

/// which history query a window applies to. Each has its own paid limit because
/// they read very different amounts of data (docs/buses.md has the measurements)
#[derive(Clone, Copy)]
enum HistoryKind {
    /// one scope's delay bins, a single compressed segment per daily chunk
    Delays,
    /// every stop's delay bins, so cost grows with the whole network
    StopRankings,
    /// the raw archive, in one-hour chunks
    Journeys,
}

impl HistoryKind {
    fn paid_max_hours(self) -> i32 {
        match self {
            // the busiest scope took ~2s at 90 days and ~8s for a year in production terms
            Self::Delays => 2_160,
            // already ~5s at 72 hours in production, so no longer window for anyone
            Self::StopRankings => PUBLIC_HISTORY_MAX_HOURS,
            // the busiest route took ~1s at 7 days and ~4s at 30 days
            Self::Journeys => 168,
        }
    }
}

fn max_history_hours(role: Option<&str>, kind: HistoryKind) -> i32 {
    if matches!(role, Some("coffee" | "pro" | "admin")) {
        kind.paid_max_hours()
    } else {
        PUBLIC_HISTORY_MAX_HOURS
    }
}

fn history_hours(ctx: &Context<'_>, hours: i32, kind: HistoryKind) -> i32 {
    let role = ctx
        .data_opt::<Option<AuthUser>>()
        .and_then(|user| user.as_ref())
        .map(|user| user.role.as_str());
    hours.clamp(1, max_history_hours(role, kind))
}

/// the archive has one chunk per hour and keeps everything, so a cutoff written
/// as NOW() - interval can't exclude chunks while planning and planning alone took
/// seconds. Binding an absolute cutoff and forcing custom plans lets TimescaleDB
/// skip old chunks up front, including after the pool reuses a prepared statement
async fn history_transaction(pool: &PgPool) -> Result<Transaction<'static, Postgres>, sqlx::Error> {
    let mut tx = pool.begin().await?;
    sqlx::query("SET LOCAL statement_timeout = '15s'")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SET LOCAL plan_cache_mode = force_custom_plan")
        .execute(&mut *tx)
        .await?;
    Ok(tx)
}

fn history_cutoff(hours: i32) -> DateTime<Utc> {
    Utc::now() - Duration::hours(i64::from(hours))
}

/// bucket width for delay history, so long windows don't return thousands of points
#[derive(Enum, Clone, Copy, Default, PartialEq, Eq)]
pub enum BusHistoryResolution {
    #[default]
    Hour,
    Day,
}

impl BusHistoryResolution {
    fn interval(self) -> &'static str {
        match self {
            Self::Hour => "1 hour",
            Self::Day => "1 day",
        }
    }
}

fn validate_feed_version(feed_version_id: i64) -> Result<i64> {
    if feed_version_id < 1 {
        return Err(Error::new("feedVersionId must be positive"));
    }
    Ok(feed_version_id)
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
        #[graphql(default)] resolution: BusHistoryResolution,
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
        let feed_version_id = feed_version_id.map(validate_feed_version).transpose()?;

        let hours = history_hours(ctx, hours, HistoryKind::Delays);
        if resolution == BusHistoryResolution::Hour && hours > HOURLY_RESOLUTION_MAX_HOURS {
            return Err(Error::new(format!(
                "Hourly history covers at most {HOURLY_RESOLUTION_MAX_HOURS} hours, use DAY resolution"
            )));
        }
        let (scope_kind, scope_id) = if let Some(id) = stop_id {
            ("stop", id)
        } else if let Some(id) = route_id {
            ("route", id)
        } else {
            ("network", String::new())
        };
        let interval = resolution.interval();
        let key = format!("{scope_kind}:{scope_id}:{feed_version_id:?}:{hours}:{interval}");
        let pool = ctx.data::<PgPool>()?.clone();
        let result = ctx
            .data::<QueryCache>()?
            .bus_delay_history
            .try_get_with(key, async move {
                let mut tx = history_transaction(&pool).await?;
                let rows = sqlx::query_as::<_, BusHistoryPoint>(
                    "SELECT to_char(time_bucket($5::interval, bucket) AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS bucket,
                            (SUM(delay_seconds::numeric * sample_count) / SUM(sample_count))::float8 AS avg_delay_seconds,
                            MAX(delay_seconds)::int4 AS max_delay_seconds,
                            bus_histogram_percentile(array_agg(delay_seconds), array_agg(sample_count), 0.95) AS p95_delay_seconds,
                            (100.0 * COALESCE(SUM(sample_count) FILTER (WHERE delay_seconds BETWEEN -60 AND 300), 0) / SUM(sample_count))::float8 AS on_time_pct,
                            COALESCE(SUM(sample_count) FILTER (WHERE delay_seconds < -60), 0)::bigint AS early_count,
                            COALESCE(SUM(sample_count) FILTER (WHERE delay_seconds > 300), 0)::bigint AS late_count,
                            SUM(sample_count)::bigint AS sample_count,
                            to_char(MAX(last_updated) AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS last_updated
                     FROM bus_delay_histogram
                     WHERE bucket >= time_bucket($5::interval, $1::timestamptz)
                       AND ($2::bigint IS NULL OR feed_version_id = $2)
                       AND scope_kind = $3 AND scope_id = $4
                     GROUP BY time_bucket($5::interval, bucket)
                     ORDER BY time_bucket($5::interval, bucket)",
                )
                .bind(history_cutoff(hours))
                .bind(feed_version_id)
                .bind(scope_kind)
                .bind(scope_id)
                .bind(interval)
                .fetch_all(&mut *tx)
                .await?;
                tx.commit().await?;
                Ok::<_, sqlx::Error>(Arc::new(rows))
            })
            .await
            .map_err(|error| Error::new(error.to_string()))?;
        Ok((*result).clone())
    }

    /// searches the whole schedule, including timetable-only routes with no realtime data
    #[graphql(complexity = 30)]
    async fn bus_routes(
        &self,
        ctx: &Context<'_>,
        search: Option<String>,
        route_id: Option<String>,
        feed_version_id: Option<i64>,
        #[graphql(default = 60)] limit: i32,
    ) -> Result<Vec<BusRoute>> {
        let search = search_pattern(search)?;
        let route_id = route_id
            .map(|id| validate_identifier(id, "routeId"))
            .transpose()?;
        let feed_version_id = feed_version_id.map(validate_feed_version).transpose()?;
        let limit = limit.clamp(1, 200);
        let key = format!("{search:?}:{route_id:?}:{feed_version_id:?}:{limit}");
        let pool = ctx.data::<PgPool>()?.clone();
        let result = ctx
            .data::<QueryCache>()?
            .bus_routes
            .try_get_with(key, async move {
                let rows = sqlx::query_as::<_, BusRoute>(
                    "SELECT route.feed_version_id, route.route_id,
                            NULLIF(BTRIM(route.route_short_name), '') AS route_short_name,
                            NULLIF(BTRIM(route.route_long_name), '') AS route_long_name,
                            NULLIF(BTRIM(agency.agency_name), '') AS operator_name,
                            feed.is_active
                     FROM bus_routes route
                     JOIN transit_feed_versions feed ON feed.id = route.feed_version_id
                     LEFT JOIN bus_agencies agency
                        ON agency.feed_version_id = route.feed_version_id
                       AND agency.agency_id = route.agency_id
                     WHERE (($1::bigint IS NULL AND feed.is_active) OR route.feed_version_id = $1)
                       AND ($2::text IS NULL OR route.route_id = $2)
                       AND ($3::text IS NULL OR route.route_short_name ILIKE $3
                            OR route.route_long_name ILIKE $3 OR route.route_id ILIKE $3
                            OR agency.agency_name ILIKE $3)
                     ORDER BY route.route_short_name, route.route_long_name,
                              route.feed_version_id, route.route_id
                     LIMIT $4",
                )
                .bind(feed_version_id)
                .bind(route_id)
                .bind(search)
                .bind(i64::from(limit))
                .fetch_all(&pool)
                .await?;
                Ok::<_, sqlx::Error>(Arc::new(rows))
            })
            .await
            .map_err(|error| Error::new(error.to_string()))?;
        Ok((*result).clone())
    }

    /// stop rankings from the same delay bins as route and network history
    #[graphql(complexity = 200)]
    async fn bus_stop_stats(
        &self,
        ctx: &Context<'_>,
        #[graphql(default = 24)] hours: i32,
        search: Option<String>,
        feed_version_id: Option<i64>,
        stop_id: Option<String>,
        #[graphql(default = 100)] limit: i32,
    ) -> Result<Vec<BusStopStats>> {
        let hours = history_hours(ctx, hours, HistoryKind::StopRankings);
        let search = search_pattern(search)?;
        let stop_id = stop_id
            .map(|id| validate_identifier(id, "stopId"))
            .transpose()?;
        if stop_id.is_some() && feed_version_id.is_none() {
            return Err(Error::new("feedVersionId is required with stopId"));
        }
        let feed_version_id = feed_version_id.map(validate_feed_version).transpose()?;
        let limit = limit.clamp(1, 200);
        let key = format!("{hours}:{search:?}:{feed_version_id:?}:{stop_id:?}:{limit}");
        let pool = ctx.data::<PgPool>()?.clone();
        let result = ctx
            .data::<QueryCache>()?
            .bus_stop_stats
            .try_get_with(key, async move {
                let mut tx = history_transaction(&pool).await?;
                let rows = sqlx::query_as::<_, BusStopStats>(
                    "SELECT histogram.feed_version_id, histogram.scope_id AS stop_id,
                            COALESCE(stop.stop_name, histogram.scope_id) AS stop_name,
                            (SUM(histogram.delay_seconds::numeric * histogram.sample_count) / SUM(histogram.sample_count))::float8 AS avg_delay_seconds,
                            bus_histogram_percentile(array_agg(histogram.delay_seconds), array_agg(histogram.sample_count), 0.95) AS p95_delay_seconds,
                            MAX(histogram.delay_seconds)::int4 AS max_delay_seconds,
                            (100.0 * COALESCE(SUM(histogram.sample_count) FILTER (WHERE histogram.delay_seconds BETWEEN -60 AND 300), 0) / SUM(histogram.sample_count))::float8 AS on_time_pct,
                            SUM(histogram.sample_count)::bigint AS sample_count
                     FROM bus_delay_histogram histogram
                     LEFT JOIN bus_stops stop
                        ON stop.feed_version_id = histogram.feed_version_id
                       AND stop.stop_id = histogram.scope_id
                     WHERE histogram.scope_kind = 'stop'
                       AND histogram.bucket >= time_bucket(INTERVAL '1 hour', $1::timestamptz)
                       AND ($2::text IS NULL OR stop.stop_name ILIKE $2 OR histogram.scope_id ILIKE $2)
                       AND ($3::bigint IS NULL OR histogram.feed_version_id = $3)
                       AND ($4::text IS NULL OR histogram.scope_id = $4)
                     GROUP BY histogram.feed_version_id, histogram.scope_id, stop.stop_name
                     ORDER BY avg_delay_seconds DESC, histogram.feed_version_id, histogram.scope_id
                     LIMIT $5",
                )
                .bind(history_cutoff(hours))
                .bind(search)
                .bind(feed_version_id)
                .bind(stop_id)
                .bind(i64::from(limit))
                .fetch_all(&mut *tx)
                .await?;
                tx.commit().await?;
                Ok::<_, sqlx::Error>(Arc::new(rows))
            })
            .await
            .map_err(|error| Error::new(error.to_string()))?;
        Ok((*result).clone())
    }

    /// latest prediction for each upcoming trip and stop on a route, including skipped stops
    #[graphql(complexity = 100)]
    async fn bus_route_stop_delays(
        &self,
        ctx: &Context<'_>,
        route_id: String,
        feed_version_id: i64,
        #[graphql(default = 100)] limit: i32,
    ) -> Result<Vec<BusRouteStopDelay>> {
        let route_id = validate_identifier(route_id, "routeId")?;
        let feed_version_id = validate_feed_version(feed_version_id)?;
        let limit = limit.clamp(1, 200);
        let key = format!("{feed_version_id}:{route_id}:{limit}");
        let pool = ctx.data::<PgPool>()?.clone();
        let result = ctx
            .data::<QueryCache>()?
            .bus_route_stop_delays
            .try_get_with(key, async move {
                let mut tx = pool.begin().await?;
                sqlx::query("SET LOCAL statement_timeout = '10s'")
                    .execute(&mut *tx)
                    .await?;
                // bus_stop_live only holds trips seen in the last half hour, so a
                // route scan stays small without a route index
                let rows = sqlx::query_as::<_, BusRouteStopDelay>(
                    "WITH latest AS (
                        SELECT live.*, freshness.last_seen_at AS observed_at,
                               UPPER(freshness.schedule_relationship) AS trip_relationship
                        FROM bus_stop_live live
                        JOIN bus_trip_update_freshness freshness
                            ON freshness.feed_version_id = live.feed_version_id
                           AND freshness.trip_instance_key = live.trip_instance_key
                        LEFT JOIN bus_trips trip
                            ON trip.feed_version_id = live.feed_version_id
                           AND trip.trip_id = live.trip_id
                        LEFT JOIN fetch_schedules poll_schedule
                            ON poll_schedule.endpoint = 'nta_realtime'
                        WHERE live.feed_version_id = $1
                          AND COALESCE(live.route_id, trip.route_id) = $2
                          AND freshness.last_seen_at > NOW() - make_interval(
                                secs => GREATEST(COALESCE(poll_schedule.interval_seconds, 60) * 3, 180)
                          )
                     )
                     SELECT latest.trip_id, latest.trip_instance_key,
                            COALESCE(latest.stop_id, stop_time.stop_id) AS stop_id,
                            stop.stop_name, latest.stop_sequence,
                            NULLIF(BTRIM(trip.trip_headsign), '') AS headsign,
                            CASE WHEN latest.trip_relationship IN ('CANCELED', 'CANCELLED', 'DELETED')
                                      OR UPPER(latest.schedule_relationship) IN ('SKIPPED', 'NO_DATA')
                                 THEN NULL
                                 ELSE COALESCE(latest.departure_delay_seconds, latest.arrival_delay_seconds)
                            END AS delay_seconds,
                            to_char(COALESCE(latest.departure_time, latest.arrival_time) AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS expected_time,
                            CASE WHEN latest.trip_relationship IN ('CANCELED', 'CANCELLED', 'DELETED')
                                 THEN latest.trip_relationship
                                 ELSE latest.schedule_relationship
                            END AS schedule_relationship,
                            to_char(latest.observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS last_updated
                     FROM latest
                     LEFT JOIN bus_stop_times stop_time
                        ON latest.stop_id IS NULL
                       AND stop_time.feed_version_id = latest.feed_version_id
                       AND stop_time.trip_id = latest.trip_id
                       AND stop_time.stop_sequence = latest.stop_sequence
                     LEFT JOIN bus_stops stop
                        ON stop.feed_version_id = latest.feed_version_id
                       AND stop.stop_id = COALESCE(latest.stop_id, stop_time.stop_id)
                     LEFT JOIN bus_trips trip
                        ON trip.feed_version_id = latest.feed_version_id
                       AND trip.trip_id = latest.trip_id
                     WHERE COALESCE(latest.departure_time, latest.arrival_time, NOW()) >= NOW() - INTERVAL '5 minutes'
                     ORDER BY COALESCE(latest.departure_time, latest.arrival_time) NULLS LAST,
                              latest.trip_instance_key, latest.stop_sequence
                     LIMIT $3",
                )
                .bind(feed_version_id)
                .bind(route_id)
                .bind(i64::from(limit))
                .fetch_all(&mut *tx)
                .await?;
                tx.commit().await?;
                Ok::<_, sqlx::Error>(Arc::new(rows))
            })
            .await
            .map_err(|error| Error::new(error.to_string()))?;
        Ok((*result).clone())
    }

    /// recorded journeys on a route, including trips no longer on the live board
    #[graphql(complexity = 200)]
    async fn bus_journeys(
        &self,
        ctx: &Context<'_>,
        feed_version_id: i64,
        route_id: String,
        #[graphql(default = 24)] hours: i32,
        #[graphql(default = 100)] limit: i32,
    ) -> Result<Vec<BusJourney>> {
        let feed_version_id = validate_feed_version(feed_version_id)?;
        let route_id = validate_identifier(route_id, "routeId")?;
        let hours = history_hours(ctx, hours, HistoryKind::Journeys);
        let limit = limit.clamp(1, 200);
        let key = format!("{feed_version_id}:{route_id}:{hours}:{limit}");
        let pool = ctx.data::<PgPool>()?.clone();
        let result = ctx
            .data::<QueryCache>()?
            .bus_journeys
            .try_get_with(key, async move {
                let mut tx = history_transaction(&pool).await?;
                // the archive has no route or trip index on purpose; the route
                // filter matches its compression segments instead
                let rows = sqlx::query_as::<_, BusJourney>(
                    "SELECT observation.feed_version_id, observation.trip_instance_key,
                            MAX(observation.trip_id) AS trip_id, MAX(observation.route_id) AS route_id,
                            MAX(NULLIF(BTRIM(trip.trip_headsign), '')) AS headsign,
                            to_char(MIN(observation.fetched_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS first_observed,
                            to_char(MAX(observation.fetched_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS last_observed,
                            COUNT(DISTINCT COALESCE(observation.stop_sequence::text, observation.stop_id)) AS stop_count
                     FROM bus_stop_observations observation
                     LEFT JOIN bus_trips trip
                        ON trip.feed_version_id = observation.feed_version_id
                       AND trip.trip_id = observation.trip_id
                     WHERE observation.feed_version_id = $1 AND observation.route_id = $2
                       AND observation.fetched_at >= $3
                     GROUP BY observation.feed_version_id, observation.trip_instance_key
                     ORDER BY MAX(observation.fetched_at) DESC, observation.trip_instance_key
                     LIMIT $4",
                )
                .bind(feed_version_id)
                .bind(route_id)
                .bind(history_cutoff(hours))
                .bind(i64::from(limit))
                .fetch_all(&mut *tx)
                .await?;
                tx.commit().await?;
                Ok::<_, sqlx::Error>(Arc::new(rows))
            })
            .await
            .map_err(|error| Error::new(error.to_string()))?;
        Ok((*result).clone())
    }

    /// last reported prediction at each stop of a recorded journey, not a confirmed arrival
    #[graphql(complexity = 200)]
    async fn bus_journey_stops(
        &self,
        ctx: &Context<'_>,
        feed_version_id: i64,
        route_id: String,
        trip_instance_key: String,
        #[graphql(default = 72)] hours: i32,
    ) -> Result<Vec<BusRouteStopDelay>> {
        let feed_version_id = validate_feed_version(feed_version_id)?;
        let route_id = validate_identifier(route_id, "routeId")?;
        let trip_instance_key = validate_identifier(trip_instance_key, "tripInstanceKey")?;
        let hours = history_hours(ctx, hours, HistoryKind::Journeys);
        let key = format!("{feed_version_id}:{route_id}:{trip_instance_key}:{hours}");
        let pool = ctx.data::<PgPool>()?.clone();
        let result = ctx
            .data::<QueryCache>()?
            .bus_journey_stops
            .try_get_with(key, async move {
                let mut tx = history_transaction(&pool).await?;
                let rows = sqlx::query_as::<_, BusRouteStopDelay>(
                    "WITH latest AS (
                        SELECT DISTINCT ON (COALESCE('sequence:' || stop_sequence::text, 'stop:' || stop_id, 'unknown')) *
                        FROM bus_stop_observations
                        WHERE feed_version_id = $1 AND route_id = $2 AND trip_instance_key = $3
                          AND fetched_at >= $4
                        ORDER BY COALESCE('sequence:' || stop_sequence::text, 'stop:' || stop_id, 'unknown'),
                                 fetched_at DESC, update_hash
                     )
                     SELECT latest.trip_id, latest.trip_instance_key, latest.stop_id, stop.stop_name,
                            latest.stop_sequence, NULLIF(BTRIM(trip.trip_headsign), '') AS headsign,
                            CASE WHEN UPPER(latest.trip_schedule_relationship) IN ('CANCELED', 'CANCELLED', 'DELETED')
                                      OR UPPER(latest.schedule_relationship) IN ('SKIPPED', 'NO_DATA')
                                 THEN NULL
                                 ELSE COALESCE(latest.departure_delay_seconds, latest.arrival_delay_seconds)
                            END AS delay_seconds,
                            to_char(COALESCE(latest.departure_time, latest.arrival_time) AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS expected_time,
                            CASE WHEN UPPER(latest.trip_schedule_relationship) IN ('CANCELED', 'CANCELLED', 'DELETED')
                                 THEN latest.trip_schedule_relationship
                                 ELSE latest.schedule_relationship
                            END AS schedule_relationship,
                            to_char(latest.fetched_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS last_updated
                     FROM latest
                     LEFT JOIN bus_stops stop
                        ON stop.feed_version_id = latest.feed_version_id AND stop.stop_id = latest.stop_id
                     LEFT JOIN bus_trips trip
                        ON trip.feed_version_id = latest.feed_version_id AND trip.trip_id = latest.trip_id
                     ORDER BY latest.stop_sequence NULLS LAST, latest.stop_id
                     LIMIT 500",
                )
                .bind(feed_version_id)
                .bind(route_id)
                .bind(trip_instance_key)
                .bind(history_cutoff(hours))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_window_is_bounded_per_role_and_query() {
        for kind in [
            HistoryKind::Delays,
            HistoryKind::StopRankings,
            HistoryKind::Journeys,
        ] {
            assert_eq!(max_history_hours(None, kind), PUBLIC_HISTORY_MAX_HOURS);
            assert_eq!(
                max_history_hours(Some("free"), kind),
                PUBLIC_HISTORY_MAX_HOURS
            );
            assert_eq!(max_history_hours(Some("pro"), kind), kind.paid_max_hours());
            assert!(kind.paid_max_hours() >= PUBLIC_HISTORY_MAX_HOURS);
        }
    }

    #[tokio::test]
    async fn long_windows_must_use_daily_resolution() {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgresql://localhost/bus_schema_validation")
            .unwrap();
        let schema = crate::schema::build_schema(pool, QueryCache::new());
        let paid = Some(AuthUser {
            id: uuid::Uuid::nil(),
            email: "paid@example.com".into(),
            role: "pro".into(),
        });
        // rejected before any database access, so the lazy pool is never used
        let response = schema
            .execute(
                async_graphql::Request::new("{ busDelayHistory(hours: 720) { bucket } }")
                    .data(paid),
            )
            .await;
        let message = &response.errors.first().expect("hourly over a week").message;
        assert!(message.contains("DAY resolution"), "{message}");
    }

    #[tokio::test]
    async fn dashboard_bus_history_queries_match_the_schema() {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgresql://localhost/bus_schema_validation")
            .unwrap();
        let schema = crate::schema::build_schema(pool, QueryCache::new());
        // skipped fields are still validated against the schema without a database
        let response = schema
            .execute(
                r#"query {
                    busRoutes(search: "409") @skip(if: true) {
                        feedVersionId routeId routeShortName routeLongName operatorName isActive
                    }
                    busDelayHistory(hours: 720, resolution: DAY) @skip(if: true) { bucket sampleCount }
                    busStopStats(hours: 24) @skip(if: true) {
                        feedVersionId stopId stopName avgDelaySeconds p95DelaySeconds maxDelaySeconds onTimePct sampleCount
                    }
                    busRouteStopDelays(routeId: "r", feedVersionId: 1) @skip(if: true) {
                        tripId tripInstanceKey stopId stopName stopSequence headsign delaySeconds expectedTime scheduleRelationship lastUpdated
                    }
                    busJourneys(feedVersionId: 1, routeId: "r") @skip(if: true) {
                        feedVersionId tripInstanceKey tripId routeId headsign firstObserved lastObserved stopCount
                    }
                    busJourneyStops(feedVersionId: 1, routeId: "r", tripInstanceKey: "t") @skip(if: true) {
                        tripId stopId delaySeconds
                    }
                }"#,
            )
            .await;
        assert!(response.errors.is_empty(), "{:?}", response.errors);
    }
}
