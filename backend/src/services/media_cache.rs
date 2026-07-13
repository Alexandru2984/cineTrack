use std::time::Duration;

use sqlx::PgPool;

const PRUNE_INTERVAL: Duration = Duration::from_secs(15 * 60);
const MAX_PROVIDER_CACHE_ROWS: i64 = 10_000;
const MAX_UNREFERENCED_MEDIA_ROWS: i64 = 250_000;

/// Remove locally browsed media after the provider-safe retention window when
/// no user data references it. Active imports pause the sweep because their
/// media rows are resolved before the final bulk commit.
pub async fn prune_orphaned_media(pool: &PgPool) -> Result<u64, sqlx::Error> {
    let expired = sqlx::query(
        r#"DELETE FROM media m
        WHERE m.last_accessed_at < NOW() - INTERVAL '175 days'
          AND NOT EXISTS (
              SELECT 1 FROM import_jobs WHERE status IN ('pending', 'running')
          )
          AND NOT EXISTS (SELECT 1 FROM user_media um WHERE um.media_id = m.id)
          AND NOT EXISTS (SELECT 1 FROM watch_history wh WHERE wh.media_id = m.id)
          AND NOT EXISTS (SELECT 1 FROM list_items li WHERE li.media_id = m.id)"#,
    )
    .execute(pool)
    .await?
    .rows_affected();

    let overflow = sqlx::query(
        r#"WITH cold_rows AS (
            SELECT m.id
            FROM media m
            WHERE NOT EXISTS (
                    SELECT 1 FROM import_jobs WHERE status IN ('pending', 'running')
                )
              AND NOT EXISTS (SELECT 1 FROM user_media um WHERE um.media_id = m.id)
              AND NOT EXISTS (SELECT 1 FROM watch_history wh WHERE wh.media_id = m.id)
              AND NOT EXISTS (SELECT 1 FROM list_items li WHERE li.media_id = m.id)
            ORDER BY m.last_accessed_at DESC, m.id
            OFFSET $1
        )
        DELETE FROM media m
        USING cold_rows
        WHERE m.id = cold_rows.id"#,
    )
    .bind(MAX_UNREFERENCED_MEDIA_ROWS)
    .execute(pool)
    .await?
    .rows_affected();

    Ok(expired + overflow)
}

/// Remove expired provider responses and evict the coldest rows above the
/// global bound. Cache writes call this too, so user-controlled search keys
/// cannot grow the table unchecked between background sweeps.
pub async fn prune_provider_response_cache(pool: &PgPool) -> Result<u64, sqlx::Error> {
    let expired = sqlx::query("DELETE FROM provider_response_cache WHERE stale_until < NOW()")
        .execute(pool)
        .await?
        .rows_affected();

    let overflow = sqlx::query(
        r#"WITH cold_rows AS (
            SELECT provider, cache_key
            FROM provider_response_cache
            ORDER BY fetched_at DESC, provider, cache_key
            OFFSET $1
        )
        DELETE FROM provider_response_cache cache
        USING cold_rows
        WHERE cache.provider = cold_rows.provider
          AND cache.cache_key = cold_rows.cache_key"#,
    )
    .bind(MAX_PROVIDER_CACHE_ROWS)
    .execute(pool)
    .await?
    .rows_affected();

    Ok(expired + overflow)
}

pub fn start_orphan_pruner(pool: PgPool) {
    actix_web::rt::spawn(async move {
        let mut interval = tokio::time::interval(PRUNE_INTERVAL);
        // Startup performs an explicit sweep; wait one full interval here.
        interval.tick().await;

        loop {
            interval.tick().await;
            match prune_orphaned_media(&pool).await {
                Ok(0) => {}
                Ok(deleted) => log::info!("Pruned {deleted} orphaned media cache row(s)"),
                Err(error) => log::error!("Failed to prune orphaned media cache: {error}"),
            }
            match prune_provider_response_cache(&pool).await {
                Ok(0) => {}
                Ok(deleted) => log::info!("Pruned {deleted} provider response cache row(s)"),
                Err(error) => log::error!("Failed to prune provider response cache: {error}"),
            }
        }
    });
}
