use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use std::time::Duration;

pub async fn create_pool(database_url: &str) -> PgPool {
    PgPoolOptions::new()
        .max_connections(10)
        .min_connections(1)
        // Fail fast instead of piling up requests when the DB is unreachable.
        .acquire_timeout(Duration::from_secs(5))
        // Recycle idle/old connections so a stale or load-balanced backend
        // doesn't keep handing out dead sockets.
        .idle_timeout(Duration::from_secs(600))
        .max_lifetime(Duration::from_secs(1800))
        .connect(database_url)
        .await
        .expect("Failed to connect to PostgreSQL")
}

/// Production runtime must never connect with cluster-wide capabilities or an
/// inherited role. Database/schema ownership is sufficient for embedded
/// migrations; superuser-style privileges turn an application compromise into
/// a database-host compromise.
pub async fn ensure_runtime_role_is_restricted(pool: &PgPool) -> anyhow::Result<()> {
    let dangerous = sqlx::query_scalar::<_, bool>(
        r#"SELECT
            r.rolsuper
            OR r.rolcreatedb
            OR r.rolcreaterole
            OR r.rolreplication
            OR r.rolbypassrls
            OR EXISTS (
                SELECT 1
                FROM pg_auth_members membership
                WHERE membership.member = r.oid
            )
        FROM pg_roles r
        WHERE r.rolname = CURRENT_USER"#,
    )
    .fetch_one(pool)
    .await?;

    anyhow::ensure!(
        !dangerous,
        "production database role has cluster-wide privileges or inherited memberships"
    );
    Ok(())
}
