//! Force a refresh of seasons still holding episodes the provider dropped.
//!
//! Caching a season removes episodes TMDB no longer lists, but only when
//! somebody opens that season. A show nobody visits keeps its stale rows
//! indefinitely, and those rows are not harmless: an episode that cannot be
//! watched still counts against the progress total and holds back the
//! completed badge. This sweep does deliberately what a visit would have done
//! by accident.

use std::time::Duration;

use sqlx::PgPool;

use crate::errors::AppError;
use crate::services::tmdb::TmdbService;

#[derive(Debug, Default, PartialEq, Eq)]
pub struct CatalogRepairSummary {
    pub seasons_selected: u64,
    pub seasons_refreshed: u64,
    pub episodes_removed: u64,
    pub failures: u64,
}

/// Seasons carrying more episodes than the provider says the season has.
///
/// `seasons.episode_count` is TMDB's own count, refreshed whenever the title is
/// re-cached, while the episode rows are only rewritten when the season itself
/// is opened. A gap between the two is exactly the drift this repairs. It will
/// miss a season whose count is equally stale, which is why this is a sweep to
/// run occasionally rather than a correctness guarantee.
const CANDIDATES: &str = r#"
    SELECT m.tmdb_id, s.season_number, c.actual - s.episode_count AS surplus
    FROM seasons s
    JOIN media m ON m.id = s.media_id
    JOIN (SELECT season_id, COUNT(*) AS actual FROM episodes GROUP BY season_id) c
      ON c.season_id = s.id
    WHERE m.media_type = 'tv'
      AND s.episode_count IS NOT NULL
      AND c.actual > s.episode_count
    ORDER BY c.actual - s.episode_count DESC
"#;

pub async fn repair_stale_catalog_episodes(
    pool: &PgPool,
    tmdb: &TmdbService,
    request_delay: Duration,
) -> Result<CatalogRepairSummary, AppError> {
    let candidates = sqlx::query_as::<_, (i32, i32, i64)>(CANDIDATES)
        .fetch_all(pool)
        .await?;

    let mut summary = CatalogRepairSummary {
        seasons_selected: candidates.len() as u64,
        ..Default::default()
    };

    for (tmdb_id, season_number, surplus) in candidates {
        // Resolving through the cache keeps this on the same path a request
        // would take, so the refresh sees the media row it expects.
        let media = match tmdb.get_or_cache_media(pool, tmdb_id, "tv").await {
            Ok(media) => media,
            Err(error) => {
                log::warn!("catalog repair: could not load TMDB id {tmdb_id}: {error}");
                summary.failures += 1;
                continue;
            }
        };

        let before = count_episodes(pool, tmdb_id, season_number).await?;
        match tmdb
            .refresh_season_episodes(pool, &media, season_number)
            .await
        {
            Ok(_) => {
                let after = count_episodes(pool, tmdb_id, season_number).await?;
                let removed = before.saturating_sub(after);
                summary.seasons_refreshed += 1;
                summary.episodes_removed += removed as u64;
                if removed > 0 {
                    log::info!(
                        "catalog repair: TMDB id {tmdb_id} season {season_number} \
                         dropped {removed} episode(s) (surplus was {surplus})"
                    );
                }
            }
            Err(error) => {
                log::warn!(
                    "catalog repair: refresh failed for TMDB id {tmdb_id} \
                     season {season_number}: {error}"
                );
                summary.failures += 1;
            }
        }

        // The provider is a shared resource and this sweep is never urgent.
        tokio::time::sleep(request_delay).await;
    }

    Ok(summary)
}

async fn count_episodes(pool: &PgPool, tmdb_id: i32, season_number: i32) -> Result<i64, AppError> {
    Ok(sqlx::query_scalar::<_, i64>(
        r#"SELECT COUNT(*)
           FROM episodes e
           JOIN seasons s ON s.id = e.season_id
           JOIN media m ON m.id = s.media_id
           WHERE m.tmdb_id = $1 AND s.season_number = $2"#,
    )
    .bind(tmdb_id)
    .bind(season_number)
    .fetch_one(pool)
    .await?)
}
