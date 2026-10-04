use async_graphql::{Context, Error, Object, Result, SimpleObject};
use sqlx::{FromRow, PgPool};
use std::sync::Arc;

use super::bus::{search_pattern, validate_identifier};
use crate::{models::AuthUser, state::QueryCache};

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

fn history_hours(hours: i32, role: Option<&str>) -> i32 {
    let max = if matches!(role, Some("coffee" | "pro" | "admin")) {
        if hours == 0 {
            return 0;
        }
        8760
    } else {
        72
    };
    hours.clamp(1, max)
}

#[derive(Default)]
pub struct BusHistoryQuery;

#[Object]
impl BusHistoryQuery {
    /// Searches the complete schedule, including routes with no realtime observations.
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
        let limit = limit.clamp(1, 200);
        let key = format!("{search:?}:{route_id:?}:{feed_version_id:?}:{limit}");
        let pool = ctx.data::<PgPool>()?.clone();
        let result = ctx.data::<QueryCache>()?.bus_routes.try_get_with(key, async move {
            let rows = sqlx::query_as::<_, BusRoute>(
                "SELECT r.feed_version_id, r.route_id, r.route_short_name, r.route_long_name,
                        a.agency_name AS operator_name, f.is_active
                 FROM bus_routes r JOIN transit_feed_versions f ON f.id = r.feed_version_id
                 LEFT JOIN bus_agencies a ON a.feed_version_id = r.feed_version_id AND a.agency_id = r.agency_id
                 WHERE (($1::bigint IS NULL AND f.is_active) OR r.feed_version_id = $1)
                   AND ($2::text IS NULL OR r.route_id = $2)
                   AND ($3::text IS NULL OR r.route_short_name ILIKE $3 OR r.route_long_name ILIKE $3
                        OR r.route_id ILIKE $3 OR a.agency_name ILIKE $3)
                 ORDER BY r.route_short_name, r.route_long_name, r.feed_version_id, r.route_id LIMIT $4"
            ).bind(feed_version_id).bind(route_id).bind(search).bind(i64::from(limit)).fetch_all(&pool).await?;
            Ok::<_, sqlx::Error>(Arc::new(rows))
        }).await.map_err(|e| Error::new(e.to_string()))?;
        Ok((*result).clone())
    }

    /// Hourly or daily observation-weighted predictions. Missing hours remain gaps.
    #[graphql(complexity = 200)]
    async fn bus_delay_history(
        &self,
        ctx: &Context<'_>,
        route_id: Option<String>,
        feed_version_id: Option<i64>,
        #[graphql(default = 24)] hours: i32,
        stop_id: Option<String>,
        since: Option<String>,
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
                "feedVersionId is required with routeId or stopId to keep schedule versions separate",
            ));
        }
        let role = ctx
            .data_opt::<Option<AuthUser>>()
            .and_then(|u| u.as_ref())
            .map(|u| u.role.as_str());
        let hours = history_hours(hours, role);
        let bucket = if hours == 0 {
            "1 week"
        } else if hours > 720 {
            "1 day"
        } else {
            "1 hour"
        };
        let since = since
            .map(|value| {
                chrono::DateTime::parse_from_rfc3339(&value)
                    .map(|date| date.with_timezone(&chrono::Utc))
                    .map_err(|_| Error::new("since must be an RFC3339 timestamp"))
            })
            .transpose()?;
        let kind = if stop_id.is_some() {
            "stop"
        } else if route_id.is_some() {
            "route"
        } else {
            "network"
        };
        let scope_id = stop_id.or(route_id).unwrap_or_default();
        let key = format!("{kind}:{scope_id}:{feed_version_id:?}:{hours}:{since:?}");
        let pool = ctx.data::<PgPool>()?.clone();
        let result = ctx.data::<QueryCache>()?.bus_delay_history.try_get_with(key, async move {
            let mut tx = pool.begin().await?;
            sqlx::query("SET LOCAL statement_timeout = '15s'").execute(&mut *tx).await?;
            let rows = sqlx::query_as::<_, BusHistoryPoint>(
                "SELECT to_char(time_bucket($4::text::interval, bucket) AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS bucket,
                        (SUM(delay_seconds::numeric * sample_count)::float8 / SUM(sample_count)) AS avg_delay_seconds,
                        MAX(delay_seconds)::int4 AS max_delay_seconds,
                        bus_histogram_percentile(array_agg(delay_seconds), array_agg(sample_count), 0.95) AS p95_delay_seconds,
                        (100.0 * COALESCE(SUM(sample_count) FILTER(WHERE delay_seconds BETWEEN -60 AND 300),0) / SUM(sample_count))::float8 AS on_time_pct,
                        COALESCE(SUM(sample_count) FILTER(WHERE delay_seconds < -60),0)::bigint AS early_count,
                        COALESCE(SUM(sample_count) FILTER(WHERE delay_seconds > 300),0)::bigint AS late_count,
                        SUM(sample_count)::bigint AS sample_count,
                        to_char(MAX(last_updated) AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS last_updated
                 FROM bus_delay_histogram
                 WHERE ($1 = 0 OR bucket >= time_bucket(INTERVAL '1 hour', NOW() - make_interval(hours => $1)))
                   AND ($2::bigint IS NULL OR feed_version_id = $2)
                   AND scope_id = $3 AND scope_kind = $5
                   AND ($6::timestamptz IS NULL OR bucket >= time_bucket($4::text::interval, $6::timestamptz))
                 GROUP BY time_bucket($4::text::interval, bucket) ORDER BY time_bucket($4::text::interval, bucket)"
            ).bind(hours).bind(feed_version_id).bind(scope_id).bind(bucket).bind(kind).bind(since).fetch_all(&mut *tx).await?;
            tx.commit().await?;
            Ok::<_, sqlx::Error>(Arc::new(rows))
        }).await.map_err(|e| Error::new(e.to_string()))?;
        Ok((*result).clone())
    }

    /// Stop rankings use the same observation definitions as route and network history.
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
        let role = ctx
            .data_opt::<Option<AuthUser>>()
            .and_then(|u| u.as_ref())
            .map(|u| u.role.as_str());
        let hours = history_hours(hours, role);
        let search = search_pattern(search)?;
        let stop_id = stop_id
            .map(|id| validate_identifier(id, "stopId"))
            .transpose()?;
        if stop_id.is_some() && feed_version_id.is_none() {
            return Err(Error::new("feedVersionId is required with stopId"));
        }
        let limit = limit.clamp(1, 200);
        let key = format!("{hours}:{search:?}:{feed_version_id:?}:{stop_id:?}:{limit}");
        let pool = ctx.data::<PgPool>()?.clone();
        let result = ctx.data::<QueryCache>()?.bus_stop_stats.try_get_with(key, async move {
            let mut tx = pool.begin().await?;
            sqlx::query("SET LOCAL statement_timeout = '15s'").execute(&mut *tx).await?;
            let rows = sqlx::query_as::<_, BusStopStats>(
                "SELECT h.feed_version_id, h.scope_id AS stop_id, COALESCE(s.stop_name,h.scope_id) AS stop_name,
                    SUM(h.delay_seconds::numeric*h.sample_count)::float8/SUM(h.sample_count) AS avg_delay_seconds,
                    bus_histogram_percentile(array_agg(h.delay_seconds),array_agg(h.sample_count),0.95) AS p95_delay_seconds,
                    MAX(h.delay_seconds) AS max_delay_seconds,
                    (100.0*COALESCE(SUM(h.sample_count) FILTER(WHERE h.delay_seconds BETWEEN -60 AND 300),0)/SUM(h.sample_count))::float8 AS on_time_pct,
                    SUM(h.sample_count)::bigint AS sample_count
                 FROM bus_delay_histogram h
                 LEFT JOIN bus_stops s ON s.feed_version_id=h.feed_version_id AND s.stop_id=h.scope_id
                 WHERE h.scope_kind='stop' AND ($1=0 OR h.bucket >= time_bucket(INTERVAL '1 hour',NOW()-make_interval(hours=>$1)))
                   AND ($2::text IS NULL OR s.stop_name ILIKE $2 OR h.scope_id ILIKE $2)
                   AND ($3::bigint IS NULL OR h.feed_version_id=$3)
                   AND ($4::text IS NULL OR h.scope_id=$4)
                 GROUP BY h.feed_version_id,h.scope_id,s.stop_name
                 ORDER BY avg_delay_seconds DESC,h.feed_version_id,h.scope_id LIMIT $5"
            ).bind(hours).bind(search).bind(feed_version_id).bind(stop_id).bind(i64::from(limit)).fetch_all(&mut *tx).await?;
            tx.commit().await?;
            Ok::<_,sqlx::Error>(Arc::new(rows))
        }).await.map_err(|e| Error::new(e.to_string()))?;
        Ok((*result).clone())
    }

    /// Recorded journeys, including trips which are no longer on the live board.
    #[graphql(complexity = 200)]
    async fn bus_journeys(
        &self,
        ctx: &Context<'_>,
        feed_version_id: i64,
        route_id: Option<String>,
        trip_instance_key: Option<String>,
        #[graphql(default = 24)] hours: i32,
        #[graphql(default = 100)] limit: i32,
    ) -> Result<Vec<BusJourney>> {
        let route_id = route_id
            .map(|id| validate_identifier(id, "routeId"))
            .transpose()?;
        let trip_instance_key = trip_instance_key
            .map(|id| validate_identifier(id, "tripInstanceKey"))
            .transpose()?;
        if route_id.is_none() && trip_instance_key.is_none() {
            return Err(Error::new("A route or journey is required"));
        }
        let role = ctx
            .data_opt::<Option<AuthUser>>()
            .and_then(|u| u.as_ref())
            .map(|u| u.role.as_str());
        let hours = history_hours(hours, role);
        let limit = limit.clamp(1, 200);
        let key = format!("{feed_version_id}:{route_id:?}:{trip_instance_key:?}:{hours}:{limit}");
        let pool = ctx.data::<PgPool>()?.clone();
        let result=ctx.data::<QueryCache>()?.bus_journeys.try_get_with(key,async move {
            let mut tx=pool.begin().await?;
            sqlx::query("SET LOCAL statement_timeout = '15s'").execute(&mut *tx).await?;
            let rows=sqlx::query_as::<_,BusJourney>(
                "SELECT u.feed_version_id,u.trip_instance_key,MAX(u.trip_id) AS trip_id,MAX(u.route_id) AS route_id,
                    MAX(t.trip_headsign) AS headsign,
                    to_char(MIN(u.fetched_at) AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS first_observed,
                    to_char(MAX(u.fetched_at) AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS last_observed,
                    COUNT(DISTINCT COALESCE(u.stop_sequence::text,u.stop_id)) AS stop_count
                 FROM bus_stop_observations u
                 LEFT JOIN bus_trips t ON t.feed_version_id=u.feed_version_id AND t.trip_id=u.trip_id
                 WHERE u.feed_version_id=$1 AND ($2::text IS NULL OR u.route_id=$2)
                    AND ($3::text IS NULL OR u.trip_instance_key=$3)
                    AND ($4=0 OR u.fetched_at>=NOW()-make_interval(hours=>$4))
                 GROUP BY u.feed_version_id,u.trip_instance_key ORDER BY MAX(u.fetched_at) DESC,u.trip_instance_key LIMIT $5"
            ).bind(feed_version_id).bind(route_id).bind(trip_instance_key).bind(hours).bind(i64::from(limit)).fetch_all(&mut *tx).await?;
            tx.commit().await?;
            Ok::<_,sqlx::Error>(Arc::new(rows))
        }).await.map_err(|e| Error::new(e.to_string()))?;
        Ok((*result).clone())
    }

    /// Last reported prediction at each stop of an archived journey, not an actual arrival.
    #[graphql(complexity = 200)]
    async fn bus_journey_stops(
        &self,
        ctx: &Context<'_>,
        feed_version_id: i64,
        trip_instance_key: String,
        #[graphql(default = 72)] hours: i32,
    ) -> Result<Vec<BusRouteStopDelay>> {
        let trip_instance_key = validate_identifier(trip_instance_key, "tripInstanceKey")?;
        let role = ctx
            .data_opt::<Option<AuthUser>>()
            .and_then(|u| u.as_ref())
            .map(|u| u.role.as_str());
        let hours = history_hours(hours, role);
        let key = format!("{feed_version_id}:{trip_instance_key}:{hours}");
        let pool = ctx.data::<PgPool>()?.clone();
        let result=ctx.data::<QueryCache>()?.bus_journey_stops.try_get_with(key,async move {
            let mut tx=pool.begin().await?;
            sqlx::query("SET LOCAL statement_timeout = '15s'").execute(&mut *tx).await?;
            let rows=sqlx::query_as::<_,BusRouteStopDelay>(
                "WITH latest AS (
                    SELECT DISTINCT ON (COALESCE('sequence:'||stop_sequence::text,'stop:'||stop_id,'unknown')) *
                    FROM bus_stop_observations WHERE feed_version_id=$1 AND trip_instance_key=$2
                      AND ($3=0 OR fetched_at>=NOW()-make_interval(hours=>$3))
                    ORDER BY COALESCE('sequence:'||stop_sequence::text,'stop:'||stop_id,'unknown'),fetched_at DESC,update_hash
                 )
                 SELECT u.trip_id,u.trip_instance_key,u.stop_id,s.stop_name,u.stop_sequence,t.trip_headsign AS headsign,
                    CASE WHEN COALESCE(f.schedule_relationship,u.trip_schedule_relationship) IN ('CANCELED','CANCELLED','DELETED') OR u.schedule_relationship IN ('SKIPPED','NO_DATA')
                        THEN NULL ELSE COALESCE(u.departure_delay_seconds,u.arrival_delay_seconds) END AS delay_seconds,
                    to_char(COALESCE(u.departure_time,u.arrival_time) AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS expected_time,
                    CASE WHEN COALESCE(f.schedule_relationship,u.trip_schedule_relationship) IN ('CANCELED','CANCELLED','DELETED') THEN COALESCE(f.schedule_relationship,u.trip_schedule_relationship) ELSE u.schedule_relationship END AS schedule_relationship,
                    to_char(u.fetched_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS last_updated
                 FROM latest u
                 LEFT JOIN LATERAL (
                    SELECT schedule_relationship FROM bus_trip_observations
                    WHERE feed_version_id=$1 AND trip_instance_key=$2
                      AND ($3=0 OR last_seen_at>=NOW()-make_interval(hours=>$3))
                    ORDER BY last_seen_at DESC LIMIT 1
                 ) f ON true
                 LEFT JOIN bus_stops s ON s.feed_version_id=u.feed_version_id AND s.stop_id=u.stop_id
                 LEFT JOIN bus_trips t ON t.feed_version_id=u.feed_version_id AND t.trip_id=u.trip_id
                 ORDER BY u.stop_sequence NULLS LAST,u.stop_id LIMIT 500"
            ).bind(feed_version_id).bind(trip_instance_key).bind(hours).fetch_all(&mut *tx).await?;
            tx.commit().await?;
            Ok::<_,sqlx::Error>(Arc::new(rows))
        }).await.map_err(|e|Error::new(e.to_string()))?;
        Ok((*result).clone())
    }

    /// Latest predictions at each trip/stop for this route, including skipped stops.
    #[graphql(complexity = 100)]
    async fn bus_route_stop_delays(
        &self,
        ctx: &Context<'_>,
        route_id: String,
        feed_version_id: i64,
        #[graphql(default = 100)] limit: i32,
    ) -> Result<Vec<BusRouteStopDelay>> {
        let route_id = validate_identifier(route_id, "routeId")?;
        let limit = limit.clamp(1, 200);
        let key = format!("{feed_version_id}:{route_id}:{limit}");
        let pool = ctx.data::<PgPool>()?.clone();
        let result = ctx.data::<QueryCache>()?.bus_route_stop_delays.try_get_with(key, async move {
            let mut tx = pool.begin().await?;
            sqlx::query("SET LOCAL statement_timeout = '10s'").execute(&mut *tx).await?;
            let rows = sqlx::query_as::<_, BusRouteStopDelay>(
                "WITH latest AS (
                    SELECT DISTINCT ON (u.trip_instance_key,
                        COALESCE('sequence:' || u.stop_sequence::text, 'stop:' || u.stop_id, 'unknown'))
                        u.*, f.last_seen_at AS observed_at, f.schedule_relationship AS trip_relationship
                    FROM bus_stop_updates u
                    JOIN bus_trip_update_freshness f USING (feed_version_id, trip_instance_key)
                    WHERE u.feed_version_id = $1 AND u.route_id = $2
                      AND f.last_seen_at > NOW() - INTERVAL '5 minutes'
                      AND u.last_seen_at > NOW() - INTERVAL '1 day'
                    ORDER BY u.trip_instance_key,
                        COALESCE('sequence:' || u.stop_sequence::text, 'stop:' || u.stop_id, 'unknown'),
                        u.last_seen_at DESC, u.id DESC
                 ) SELECT u.trip_id, u.trip_instance_key, u.stop_id, s.stop_name, u.stop_sequence,
                          t.trip_headsign AS headsign,
                          CASE WHEN u.trip_relationship IN ('CANCELED', 'CANCELLED', 'DELETED')
                                  OR u.schedule_relationship IN ('SKIPPED', 'NO_DATA') THEN NULL
                               ELSE COALESCE(u.departure_delay_seconds, u.arrival_delay_seconds) END AS delay_seconds,
                          to_char(COALESCE(u.departure_time, u.arrival_time) AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS expected_time,
                          CASE WHEN u.trip_relationship IN ('CANCELED', 'CANCELLED', 'DELETED') THEN u.trip_relationship
                               ELSE u.schedule_relationship END AS schedule_relationship,
                          to_char(u.observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS last_updated
                   FROM latest u
                   LEFT JOIN bus_stops s ON s.feed_version_id = u.feed_version_id AND s.stop_id = u.stop_id
                   LEFT JOIN bus_trips t ON t.feed_version_id = u.feed_version_id AND t.trip_id = u.trip_id
                   WHERE COALESCE(u.departure_time, u.arrival_time, NOW()) >= NOW() - INTERVAL '5 minutes'
                   ORDER BY COALESCE(u.departure_time, u.arrival_time) NULLS LAST, u.trip_instance_key, u.stop_sequence LIMIT $3"
            ).bind(feed_version_id).bind(route_id).bind(i64::from(limit)).fetch_all(&mut *tx).await?;
            tx.commit().await?;
            Ok::<_, sqlx::Error>(Arc::new(rows))
        }).await.map_err(|e| Error::new(e.to_string()))?;
        Ok((*result).clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn dashboard_queries_match_the_graphql_schema() {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgresql://localhost/bus_schema_validation")
            .unwrap();
        let schema = crate::schema::build_schema(pool, QueryCache::new());
        // Skipped fields still undergo schema/type validation, with no DB connection.
        let response = schema.execute(async_graphql::Request::new(r#"
            query BusPages($routeId: String!, $feedVersionId: Int!, $hours: Int) {
                busRoutes(routeId: $routeId, feedVersionId: $feedVersionId) @skip(if: true) {
                    feedVersionId routeId routeShortName routeLongName operatorName isActive
                }
                busDelayHistory(routeId: $routeId, feedVersionId: $feedVersionId, hours: $hours) @skip(if: true) {
                    bucket avgDelaySeconds p95DelaySeconds maxDelaySeconds onTimePct earlyCount lateCount sampleCount lastUpdated
                }
                busRouteStopDelays(routeId: $routeId, feedVersionId: $feedVersionId) @skip(if: true) {
                    tripId tripInstanceKey stopId stopName stopSequence headsign delaySeconds expectedTime scheduleRelationship lastUpdated
                }
                busRouteDelays @skip(if: true) { feedVersionId routeId avgDelaySeconds }
            }
        "#).variables(async_graphql::Variables::from_json(serde_json::json!({
            "routeId": "route", "feedVersionId": 1, "hours": 24
        })))).await;
        assert!(response.errors.is_empty(), "{:?}", response.errors);
        let response = schema.execute(r#"query {
                busStopStats @skip(if: true) { feedVersionId stopId stopName avgDelaySeconds p95DelaySeconds maxDelaySeconds onTimePct sampleCount }
                busJourneys(feedVersionId: 1, routeId: "route") @skip(if: true) {
                    feedVersionId tripInstanceKey tripId routeId headsign firstObserved lastObserved stopCount
                }
                busJourneyStops(feedVersionId: 1, tripInstanceKey: "fixture") @skip(if: true) {
                    tripId tripInstanceKey stopId stopName stopSequence headsign delaySeconds expectedTime scheduleRelationship lastUpdated
                }

        }"#).await;
        assert!(response.errors.is_empty(), "{:?}", response.errors);
    }

    #[test]
    fn history_access_is_bounded_per_role() {
        assert_eq!(history_hours(8760, None), 72);
        assert_eq!(history_hours(8760, Some("free")), 72);
        assert_eq!(history_hours(10000, Some("pro")), 8760);
        assert_eq!(history_hours(-1, Some("admin")), 1);
        assert_eq!(history_hours(0, Some("pro")), 0);
        assert_eq!(history_hours(0, None), 1);
    }
}
