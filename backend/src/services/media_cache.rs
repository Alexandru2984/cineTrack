use std::time::Duration;

use sqlx::PgPool;

const PRUNE_INTERVAL: Duration = Duration::from_secs(60);

/// Remove cache rows that have had enough time to become referenced by a
/// tracking/import transaction but are still unused. Active imports pause the
/// sweep because their media rows are resolved before the final bulk commit.
pub async fn prune_orphaned_media(pool: &PgPool) -> Result<u64, sqlx::Error> {
    let deleted = sqlx::query(
        r#"DELETE FROM media m
        WHERE m.tmdb_cached_at < NOW() - INTERVAL '2 minutes'
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

    Ok(deleted)
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
        }
    });
}
