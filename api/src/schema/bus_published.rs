use async_graphql::{Context, Error, Object, Result, SimpleObject};
use sqlx::{FromRow, PgPool};
use std::sync::Arc;

use super::bus::{search_pattern, validate_identifier};
use crate::state::QueryCache;

const PAGE_LIMIT: (i32, i32) = (1, 500);
const MAX_OFFSET: i32 = 100_000;

#[derive(Clone, SimpleObject, FromRow)]
pub struct BusPublishedDataset {
    pub import_id: String,
    pub imported_at: String,
    pub source_updated_at: Option<String>,
    pub record_count: i32,
    pub first_year: i32,
    pub last_year: i32,
    pub route_count: i64,
    pub operators: Vec<String>,
    pub years: Vec<i32>,
}

#[derive(Clone, SimpleObject, FromRow)]
pub struct BusPublishedPoint {
    pub operator_name: String,
    pub route_short_name: String,
    pub report_year: i32,
    pub report_period: i32,
    pub on_time_pct: Option<f64>,
    pub early_pct: Option<f64>,
    pub late_pct: Option<f64>,
    pub actual_departures: Option<i64>,
    pub excess_wait_minutes: Option<f64>,
    pub planned_km: Option<f64>,
    pub actual_km: Option<f64>,
    pub lost_km: Option<f64>,
    pub contractual_lost_km: Option<f64>,
}

#[derive(Clone, SimpleObject)]
pub struct BusPublishedPage {
    pub total_count: i64,
    pub rows: Vec<BusPublishedPoint>,
}

fn validate_import_id(import_id: &str) -> Result<()> {
    if import_id.len() == 64
        && import_id
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    {
        Ok(())
    } else {
        Err(Error::new("Invalid published import ID"))
    }
}

#[derive(Default)]
pub struct BusPublishedQuery;

#[Object]
impl BusPublishedQuery {
    /// the active NTA published-performance snapshot, or null before the first import
    #[graphql(complexity = 50)]
    async fn bus_published_dataset(
        &self,
        ctx: &Context<'_>,
    ) -> Result<Option<BusPublishedDataset>> {
        let pool = ctx.data::<PgPool>()?.clone();
        let result = ctx
            .data::<QueryCache>()?
            .bus_published_dataset
            .try_get_with((), async move {
                let row = sqlx::query_as::<_, BusPublishedDataset>(
                    "SELECT snapshot.import_id,
                            to_char(snapshot.imported_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS imported_at,
                            to_char(snapshot.source_updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS source_updated_at,
                            snapshot.record_count, snapshot.first_year, snapshot.last_year,
                            COUNT(DISTINCT (record.operator_name, record.route_short_name)) AS route_count,
                            array_agg(DISTINCT record.operator_name ORDER BY record.operator_name) AS operators,
                            array_agg(DISTINCT record.report_year ORDER BY record.report_year DESC) AS years
                     FROM bus_published_imports snapshot
                     JOIN bus_published_performance record USING (import_id)
                     WHERE snapshot.is_active
                     GROUP BY snapshot.import_id",
                )
                .fetch_optional(&pool)
                .await?;
                Ok::<_, sqlx::Error>(Arc::new(row))
            })
            .await
            .map_err(|error| Error::new(error.to_string()))?;
        Ok((*result).clone())
    }

    /// published route-period records, newest reporting period first
    #[graphql(complexity = 150)]
    async fn bus_published_performance(
        &self,
        ctx: &Context<'_>,
        import_id: String,
        search: Option<String>,
        operator_name: Option<String>,
        route_short_name: Option<String>,
        year: Option<i32>,
        #[graphql(default = 200)] limit: i32,
        #[graphql(default = 0)] offset: i32,
    ) -> Result<BusPublishedPage> {
        validate_import_id(&import_id)?;
        let search = search_pattern(search)?;
        let operator_name = operator_name
            .map(|name| validate_identifier(name, "operatorName"))
            .transpose()?;
        let route_short_name = route_short_name
            .map(|name| validate_identifier(name, "routeShortName"))
            .transpose()?;
        if year.is_some_and(|year| !(2000..=2100).contains(&year)) {
            return Err(Error::new("Invalid report year"));
        }
        let limit = limit.clamp(PAGE_LIMIT.0, PAGE_LIMIT.1);
        let offset = offset.clamp(0, MAX_OFFSET);
        let key = format!(
            "{import_id}:{search:?}:{operator_name:?}:{route_short_name:?}:{year:?}:{limit}:{offset}"
        );
        let pool = ctx.data::<PgPool>()?.clone();
        let result = ctx
            .data::<QueryCache>()?
            .bus_published_performance
            .try_get_with(key, async move {
                let mut tx = pool.begin().await?;
                sqlx::query("SET LOCAL statement_timeout = '10s'")
                    .execute(&mut *tx)
                    .await?;
                let rows = sqlx::query_as::<_, BusPublishedPoint>(
                    "SELECT operator_name, route_short_name, report_year, report_period,
                            on_time_pct, early_pct, late_pct, actual_departures, excess_wait_minutes,
                            planned_km, actual_km, lost_km, contractual_lost_km
                     FROM bus_published_performance
                     WHERE import_id = $1
                       AND ($2::text IS NULL OR route_short_name ILIKE $2 OR operator_name ILIKE $2)
                       AND ($3::text IS NULL OR operator_name = $3)
                       AND ($4::text IS NULL OR route_short_name = $4)
                       AND ($5::int4 IS NULL OR report_year = $5)
                     ORDER BY report_year DESC, report_period DESC, operator_name, route_short_name
                     LIMIT $6 OFFSET $7",
                )
                .bind(&import_id)
                .bind(&search)
                .bind(&operator_name)
                .bind(&route_short_name)
                .bind(year)
                .bind(i64::from(limit))
                .bind(i64::from(offset))
                .fetch_all(&mut *tx)
                .await?;
                let total_count = sqlx::query_scalar::<_, i64>(
                    "SELECT COUNT(*) FROM bus_published_performance
                     WHERE import_id = $1
                       AND ($2::text IS NULL OR route_short_name ILIKE $2 OR operator_name ILIKE $2)
                       AND ($3::text IS NULL OR operator_name = $3)
                       AND ($4::text IS NULL OR route_short_name = $4)
                       AND ($5::int4 IS NULL OR report_year = $5)",
                )
                .bind(&import_id)
                .bind(&search)
                .bind(&operator_name)
                .bind(&route_short_name)
                .bind(year)
                .fetch_one(&mut *tx)
                .await?;
                tx.commit().await?;
                Ok::<_, sqlx::Error>(Arc::new(BusPublishedPage { total_count, rows }))
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
    fn import_ids_are_lowercase_sha256() {
        assert!(validate_import_id(&"a".repeat(64)).is_ok());
        assert!(validate_import_id(&"A".repeat(64)).is_err());
        assert!(validate_import_id(&"a".repeat(63)).is_err());
        assert!(validate_import_id("fixture").is_err());
    }

    #[tokio::test]
    async fn dashboard_published_queries_match_the_schema() {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgresql://localhost/published_schema_validation")
            .unwrap();
        let schema = crate::schema::build_schema(pool, QueryCache::new());
        // skipped fields are still validated against the schema without a database
        let response = schema
            .execute(
                r#"query {
                    busPublishedDataset @skip(if: true) {
                        importId importedAt sourceUpdatedAt recordCount firstYear lastYear routeCount operators years
                    }
                    busPublishedPerformance(importId: "fixture", search: "409", year: 2025) @skip(if: true) {
                        totalCount
                        rows {
                            operatorName routeShortName reportYear reportPeriod onTimePct earlyPct latePct
                            actualDepartures excessWaitMinutes plannedKm actualKm lostKm contractualLostKm
                        }
                    }
                }"#,
            )
            .await;
        assert!(response.errors.is_empty(), "{:?}", response.errors);
    }
}
