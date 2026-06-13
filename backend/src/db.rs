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
