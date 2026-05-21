use sqlx::{PgPool, FromRow};

#[derive(Debug, Clone, FromRow)]
pub struct DailyUsageRecord {
    pub request_count: i64,
    pub role_snapshot: String,
    pub for_date: chrono::NaiveDate,
}

pub async fn record_graphql_request(
    pool: &PgPool,
    subject: &str,
    role_snapshot: &str,
) -> Result<DailyUsageRecord, sqlx::Error> {
    sqlx::query_as::<_, DailyUsageRecord>(
        "
        INSERT INTO api_daily_usage (for_date, subject, request_count, role_snapshot, updated_at)
        VALUES (CURRENT_DATE, $1, 1, $2, NOW())
        ON CONFLICT (for_date, subject)
        DO UPDATE SET
            request_count = api_daily_usage.request_count + 1,
            role_snapshot = EXCLUDED.role_snapshot,
            updated_at = NOW()
        RETURNING request_count, role_snapshot, for_date
        ",
    )
    .bind(subject)
    .bind(role_snapshot)
    .fetch_one(pool)
    .await
}

pub async fn get_subject_usage(
    pool: &PgPool,
    subject: &str,
) -> Result<Option<DailyUsageRecord>, sqlx::Error> {
    sqlx::query_as::<_, DailyUsageRecord>(
        "
        SELECT request_count, role_snapshot, for_date
        FROM api_daily_usage
        WHERE for_date = CURRENT_DATE AND subject = $1
        ",
    )
    .bind(subject)
    .fetch_optional(pool)
    .await
}

