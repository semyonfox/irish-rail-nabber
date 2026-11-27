use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use crate::models::UserRow;

pub async fn find_user_by_id(pool: &PgPool, id: Uuid) -> Result<Option<UserRow>, sqlx::Error> {
    sqlx::query_as::<_, UserRow>(
        "SELECT id, email, clerk_user_id, display_name, role,
                polar_customer_id, polar_subscription_id, created_at, updated_at
         FROM users
         WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await
}

pub async fn find_user_by_clerk_id(
    pool: &PgPool,
    clerk_user_id: &str,
) -> Result<Option<UserRow>, sqlx::Error> {
    sqlx::query_as::<_, UserRow>(
        "SELECT id, email, clerk_user_id, display_name, role,
                polar_customer_id, polar_subscription_id, created_at, updated_at
         FROM users
         WHERE clerk_user_id = $1",
    )
    .bind(clerk_user_id)
    .fetch_optional(pool)
    .await
}

pub async fn find_user_id_by_polar_customer(
    pool: &PgPool,
    polar_customer_id: &str,
) -> Result<Option<Uuid>, sqlx::Error> {
    sqlx::query_scalar("SELECT id FROM users WHERE polar_customer_id = $1")
        .bind(polar_customer_id)
        .fetch_optional(pool)
        .await
}

// attach a clerk identity to a pre-clerk account with the same verified email,
// otherwise create a fresh free account
pub async fn link_or_create_clerk_user(
    pool: &PgPool,
    clerk_user_id: &str,
    email: &str,
    display_name: Option<&str>,
) -> Result<UserRow, sqlx::Error> {
    let linked = sqlx::query_as::<_, UserRow>(
        "UPDATE users
         SET clerk_user_id = $1,
             display_name = COALESCE(display_name, $3)
         WHERE lower(email) = lower($2) AND clerk_user_id IS NULL
         RETURNING id, email, clerk_user_id, display_name, role,
                   polar_customer_id, polar_subscription_id, created_at, updated_at",
    )
    .bind(clerk_user_id)
    .bind(email)
    .bind(display_name)
    .fetch_optional(pool)
    .await?;

    if let Some(user) = linked {
        return Ok(user);
    }

    sqlx::query_as::<_, UserRow>(
        "INSERT INTO users (email, clerk_user_id, display_name)
         VALUES ($2, $1, $3)
         ON CONFLICT (clerk_user_id) DO UPDATE SET email = EXCLUDED.email
         RETURNING id, email, clerk_user_id, display_name, role,
                   polar_customer_id, polar_subscription_id, created_at, updated_at",
    )
    .bind(clerk_user_id)
    .bind(email)
    .bind(display_name)
    .fetch_one(pool)
    .await
}

#[derive(Debug, PartialEq, Eq)]
pub enum PolarStateApply {
    Applied { clerk_user_id: Option<String> },
    Duplicate,
    Stale,
    MissingUser,
}

pub struct PolarStateUpdate<'a> {
    pub event_id: &'a str,
    pub event_type: &'a str,
    pub occurred_at: DateTime<Utc>,
    pub user_id: Uuid,
    pub customer_id: &'a str,
    pub subscription_id: Option<&'a str>,
    pub role: &'a str,
}

pub async fn apply_polar_state(
    pool: &PgPool,
    update: PolarStateUpdate<'_>,
) -> Result<PolarStateApply, sqlx::Error> {
    let mut tx = pool.begin().await?;

    let inserted = sqlx::query_scalar::<_, String>(
        "INSERT INTO billing_webhook_events
             (provider, event_id, event_type, occurred_at)
         VALUES ('polar', $1, $2, $3)
         ON CONFLICT (provider, event_id) DO NOTHING
         RETURNING event_id",
    )
    .bind(update.event_id)
    .bind(update.event_type)
    .bind(update.occurred_at)
    .fetch_optional(&mut *tx)
    .await?;

    if inserted.is_none() {
        tx.commit().await?;
        return Ok(PolarStateApply::Duplicate);
    }

    let updated = sqlx::query_as::<_, (Option<String>,)>(
        "UPDATE users
         SET polar_customer_id = $2,
             polar_subscription_id = $3,
             polar_state_updated_at = $4,
             role = CASE WHEN role = 'admin' THEN role ELSE $5 END
         WHERE id = $1
           AND (polar_state_updated_at IS NULL OR polar_state_updated_at < $4)
         RETURNING clerk_user_id",
    )
    .bind(update.user_id)
    .bind(update.customer_id)
    .bind(update.subscription_id)
    .bind(update.occurred_at)
    .bind(update.role)
    .fetch_optional(&mut *tx)
    .await?;

    if let Some((clerk_user_id,)) = updated {
        tx.commit().await?;
        return Ok(PolarStateApply::Applied { clerk_user_id });
    }

    let exists = sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM users WHERE id = $1)")
        .bind(update.user_id)
        .fetch_one(&mut *tx)
        .await?;

    if exists {
        tx.commit().await?;
        Ok(PolarStateApply::Stale)
    } else {
        tx.rollback().await?;
        Ok(PolarStateApply::MissingUser)
    }
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;

    use super::*;

    #[tokio::test]
    #[ignore = "requires a disposable PostgreSQL database named polar_test"]
    async fn polar_state_is_replay_safe_and_ordered() {
        let database_url = std::env::var("TEST_DATABASE_URL").expect("TEST_DATABASE_URL");
        let pool = PgPool::connect(&database_url).await.unwrap();
        let database = sqlx::query_scalar::<_, String>("SELECT current_database()")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            database, "polar_test",
            "refusing to mutate a non-test database"
        );

        for migration in [
            include_str!("../../../migrations/004_add_users_and_auth.sql"),
            include_str!("../../../migrations/009_clerk_auth.sql"),
            include_str!("../../../migrations/010_polar_billing.sql"),
        ] {
            sqlx::raw_sql(migration).execute(&pool).await.unwrap();
        }

        let user_id = Uuid::new_v4();
        sqlx::query("INSERT INTO users (id, email) VALUES ($1, $2)")
            .bind(user_id)
            .bind(format!("{user_id}@example.com"))
            .execute(&pool)
            .await
            .unwrap();

        let first_at = Utc.with_ymd_and_hms(2026, 9, 12, 10, 0, 0).unwrap();
        let first = PolarStateUpdate {
            event_id: "evt-first",
            event_type: "customer.state_changed",
            occurred_at: first_at,
            user_id,
            customer_id: "customer-1",
            subscription_id: Some("coffee-sub"),
            role: "coffee",
        };
        assert_eq!(
            apply_polar_state(&pool, first).await.unwrap(),
            PolarStateApply::Applied {
                clerk_user_id: None
            }
        );
        assert_eq!(
            find_user_id_by_polar_customer(&pool, "customer-1")
                .await
                .unwrap(),
            Some(user_id)
        );

        let duplicate = PolarStateUpdate {
            event_id: "evt-first",
            event_type: "customer.state_changed",
            occurred_at: first_at + chrono::Duration::minutes(10),
            user_id,
            customer_id: "customer-1",
            subscription_id: Some("pro-sub"),
            role: "pro",
        };
        assert_eq!(
            apply_polar_state(&pool, duplicate).await.unwrap(),
            PolarStateApply::Duplicate
        );

        let stale = PolarStateUpdate {
            event_id: "evt-stale",
            event_type: "customer.state_changed",
            occurred_at: first_at - chrono::Duration::minutes(1),
            user_id,
            customer_id: "customer-1",
            subscription_id: None,
            role: "free",
        };
        assert_eq!(
            apply_polar_state(&pool, stale).await.unwrap(),
            PolarStateApply::Stale
        );

        let (role, subscription_id) = sqlx::query_as::<_, (String, Option<String>)>(
            "SELECT role, polar_subscription_id FROM users WHERE id = $1",
        )
        .bind(user_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(role, "coffee");
        assert_eq!(subscription_id.as_deref(), Some("coffee-sub"));

        let cancelled = PolarStateUpdate {
            event_id: "evt-cancelled",
            event_type: "customer.state_changed",
            occurred_at: first_at + chrono::Duration::minutes(1),
            user_id,
            customer_id: "customer-1",
            subscription_id: None,
            role: "free",
        };
        assert!(matches!(
            apply_polar_state(&pool, cancelled).await.unwrap(),
            PolarStateApply::Applied { .. }
        ));

        let role = sqlx::query_scalar::<_, String>("SELECT role FROM users WHERE id = $1")
            .bind(user_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(role, "free");
    }
}
