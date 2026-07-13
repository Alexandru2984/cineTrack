use std::time::Duration;

use chrono::{DateTime, Utc};
use sqlx::{FromRow, PgPool};

use crate::errors::AppError;
use crate::services::tmdb::TmdbService;

const HYDRATION_ADVISORY_LOCK: i64 = 0x4349_4e45_5452_4143;
const DETAIL_REFRESH_DAYS: i64 = 30;

#[derive(Clone, Copy, Debug)]
pub struct HydrationOptions {
    pub budget: u32,
    pub request_delay: Duration,
}

#[derive(Debug, Default, Eq, PartialEq)]
pub struct HydrationSummary {
    pub selected: usize,
    pub succeeded: usize,
    pub not_found: usize,
    pub transient_failures: usize,
    pub invalid: usize,
    pub stopped_early: bool,
    pub skipped_locked: bool,
}

#[derive(FromRow)]
struct HydrationCandidate {
    media_type: String,
    tmdb_id: i32,
    consecutive_failures: i16,
}

fn retry_delay(outcome: &str, previous_failures: i16) -> chrono::Duration {
    let exponent = u32::from(previous_failures.clamp(0, 5) as u16);
    let multiplier = i64::from(1_u32 << exponent);
    match outcome {
        "transient" => chrono::Duration::hours(multiplier.min(24)),
        "not_found" | "invalid" => chrono::Duration::days(multiplier.min(30)),
        _ => chrono::Duration::days(1),
    }
}

async fn mark_success(pool: &PgPool, candidate: &HydrationCandidate) -> Result<(), sqlx::Error> {
    let next_attempt_at = Utc::now() + chrono::Duration::days(DETAIL_REFRESH_DAYS);
    sqlx::query(
        r#"INSERT INTO catalog_hydration_state
            (media_type, tmdb_id, outcome, consecutive_failures,
             last_attempt_at, next_attempt_at, last_success_at)
        VALUES ($1, $2, 'success', 0, NOW(), $3, NOW())
        ON CONFLICT (media_type, tmdb_id) DO UPDATE SET
            outcome = 'success',
            consecutive_failures = 0,
            last_attempt_at = NOW(),
            next_attempt_at = EXCLUDED.next_attempt_at,
            last_success_at = NOW()"#,
    )
    .bind(&candidate.media_type)
    .bind(candidate.tmdb_id)
    .bind(next_attempt_at)
    .execute(pool)
    .await?;
    Ok(())
}

async fn mark_failure(
    pool: &PgPool,
    candidate: &HydrationCandidate,
    outcome: &'static str,
) -> Result<(), sqlx::Error> {
    let next_attempt_at: DateTime<Utc> =
        Utc::now() + retry_delay(outcome, candidate.consecutive_failures);
    sqlx::query(
        r#"INSERT INTO catalog_hydration_state
            (media_type, tmdb_id, outcome, consecutive_failures,
             last_attempt_at, next_attempt_at)
        VALUES ($1, $2, $3, 1, NOW(), $4)
        ON CONFLICT (media_type, tmdb_id) DO UPDATE SET
            outcome = EXCLUDED.outcome,
            consecutive_failures = LEAST(
                15,
                catalog_hydration_state.consecutive_failures + 1
            ),
            last_attempt_at = NOW(),
            next_attempt_at = EXCLUDED.next_attempt_at"#,
    )
    .bind(&candidate.media_type)
    .bind(candidate.tmdb_id)
    .bind(outcome)
    .bind(next_attempt_at)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn hydrate_popular_catalog(
    pool: &PgPool,
    tmdb: &TmdbService,
    options: HydrationOptions,
) -> Result<HydrationSummary, AppError> {
    if options.budget == 0 {
        return Err(AppError::BadRequest(
            "Catalog hydration budget must be positive".to_string(),
        ));
    }

    // A transaction-scoped advisory lock is released on every return path,
    // including provider and database errors.
    let mut lock_transaction = pool.begin().await?;
    let acquired = sqlx::query_scalar::<_, bool>("SELECT pg_try_advisory_xact_lock($1)")
        .bind(HYDRATION_ADVISORY_LOCK)
        .fetch_one(&mut *lock_transaction)
        .await?;
    if !acquired {
        return Ok(HydrationSummary {
            skipped_locked: true,
            ..HydrationSummary::default()
        });
    }

    let inventory_is_fresh = sqlx::query_scalar::<_, bool>(
        r#"SELECT EXISTS (
            SELECT 1
            FROM catalog_sync_state sync
            WHERE sync.provider = 'tmdb'
              AND sync.export_date >= CURRENT_DATE - 2
              AND EXISTS (SELECT 1 FROM catalog_external_titles)
        )"#,
    )
    .fetch_one(pool)
    .await?;
    if !inventory_is_fresh {
        return Err(AppError::ServiceUnavailable(
            "Catalog inventory is missing or stale".to_string(),
        ));
    }

    let candidates = sqlx::query_as::<_, HydrationCandidate>(
        r#"SELECT
            ids.media_type,
            ids.tmdb_id,
            COALESCE(state.consecutive_failures, 0::smallint) AS consecutive_failures
        FROM catalog_external_ids ids
        JOIN catalog_external_titles titles
          USING (media_type, tmdb_id)
        LEFT JOIN media
          ON media.tmdb_id = ids.tmdb_id
         AND media.media_type = ids.media_type
        LEFT JOIN catalog_hydration_state state
          ON state.media_type = ids.media_type
         AND state.tmdb_id = ids.tmdb_id
        WHERE ids.adult = FALSE
          AND ids.video = FALSE
          AND (state.next_attempt_at IS NULL OR state.next_attempt_at <= NOW())
          AND (
              media.id IS NULL
              OR media.metadata_level <> 'detail'
              OR media.tmdb_cached_at < NOW() - INTERVAL '30 days'
              OR media.title_aliases_cached_at IS NULL
          )
        ORDER BY ids.popularity DESC, ids.media_type, ids.tmdb_id
        LIMIT $1"#,
    )
    .bind(i64::from(options.budget))
    .fetch_all(pool)
    .await?;

    let mut summary = HydrationSummary {
        selected: candidates.len(),
        ..HydrationSummary::default()
    };
    for (index, candidate) in candidates.iter().enumerate() {
        if index > 0 && !options.request_delay.is_zero() {
            tokio::time::sleep(options.request_delay).await;
        }

        match tmdb
            .refresh_media(pool, candidate.tmdb_id, &candidate.media_type)
            .await
        {
            Ok(_) => {
                mark_success(pool, candidate).await?;
                summary.succeeded += 1;
            }
            Err(error @ (AppError::DatabaseError(_) | AppError::InternalError(_))) => {
                return Err(error);
            }
            Err(AppError::NotFound(_)) => {
                mark_failure(pool, candidate, "not_found").await?;
                summary.not_found += 1;
            }
            Err(
                AppError::ServiceUnavailable(_)
                | AppError::TooManyRequests(_)
                | AppError::TmdbError(_),
            ) => {
                mark_failure(pool, candidate, "transient").await?;
                summary.transient_failures += 1;
                summary.stopped_early = true;
                break;
            }
            Err(_) => {
                mark_failure(pool, candidate, "invalid").await?;
                summary.invalid += 1;
            }
        }
    }

    lock_transaction.rollback().await?;
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_backoff_is_bounded() {
        assert_eq!(retry_delay("transient", 0), chrono::Duration::hours(1));
        assert_eq!(retry_delay("transient", 8), chrono::Duration::hours(24));
        assert_eq!(retry_delay("not_found", 2), chrono::Duration::days(4));
        assert_eq!(retry_delay("invalid", 12), chrono::Duration::days(30));
    }
}
