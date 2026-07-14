use std::time::Duration;

use chrono::{DateTime, NaiveDate, Utc};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

use crate::errors::AppError;
use crate::models::Media;
use crate::services::tmdb::TmdbService;

const RELEASE_SCHEDULE_ADVISORY_LOCK: i64 = 0x5641_5a55_5445_5343;

#[derive(Clone, Copy, Debug)]
pub struct ReleaseScheduleOptions {
    pub budget: u32,
    pub request_delay: Duration,
}

#[derive(Debug, Default, Eq, PartialEq)]
pub struct ReleaseScheduleSummary {
    pub selected: usize,
    pub succeeded: usize,
    pub tv_titles: usize,
    pub movie_titles: usize,
    pub refreshed_seasons: usize,
    pub cached_movie_dates: usize,
    pub not_found: usize,
    pub transient_failures: usize,
    pub invalid: usize,
    pub stopped_early: bool,
    pub skipped_locked: bool,
}

#[derive(Debug, FromRow)]
struct ReleaseScheduleCandidate {
    id: Uuid,
    tmdb_id: i32,
    media_type: String,
    status: Option<String>,
    release_date: Option<NaiveDate>,
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

fn success_delay(candidate: &ReleaseScheduleCandidate) -> chrono::Duration {
    if candidate.media_type == "movie" {
        if candidate
            .release_date
            .is_some_and(|date| date < Utc::now().date_naive() - chrono::Duration::days(30))
        {
            return chrono::Duration::days(30);
        }
        return chrono::Duration::days(1);
    }

    if candidate.status.as_deref().is_some_and(|status| {
        status.eq_ignore_ascii_case("ended") || status.eq_ignore_ascii_case("canceled")
    }) {
        chrono::Duration::days(7)
    } else {
        chrono::Duration::hours(6)
    }
}

async fn mark_success(
    pool: &PgPool,
    candidate: &ReleaseScheduleCandidate,
) -> Result<(), sqlx::Error> {
    let next_attempt_at = Utc::now() + success_delay(candidate);
    sqlx::query(
        r#"INSERT INTO release_schedule_sync_state
            (media_id, outcome, consecutive_failures, last_attempt_at,
             next_attempt_at, last_success_at)
        VALUES ($1, 'success', 0, NOW(), $2, NOW())
        ON CONFLICT (media_id) DO UPDATE SET
            outcome = 'success',
            consecutive_failures = 0,
            last_attempt_at = NOW(),
            next_attempt_at = EXCLUDED.next_attempt_at,
            last_success_at = NOW()"#,
    )
    .bind(candidate.id)
    .bind(next_attempt_at)
    .execute(pool)
    .await?;
    Ok(())
}

async fn mark_failure(
    pool: &PgPool,
    candidate: &ReleaseScheduleCandidate,
    outcome: &'static str,
) -> Result<(), sqlx::Error> {
    let next_attempt_at: DateTime<Utc> =
        Utc::now() + retry_delay(outcome, candidate.consecutive_failures);
    sqlx::query(
        r#"INSERT INTO release_schedule_sync_state
            (media_id, outcome, consecutive_failures, last_attempt_at, next_attempt_at)
        VALUES ($1, $2, 1, NOW(), $3)
        ON CONFLICT (media_id) DO UPDATE SET
            outcome = EXCLUDED.outcome,
            consecutive_failures = LEAST(
                15,
                release_schedule_sync_state.consecutive_failures + 1
            ),
            last_attempt_at = NOW(),
            next_attempt_at = EXCLUDED.next_attempt_at"#,
    )
    .bind(candidate.id)
    .bind(outcome)
    .bind(next_attempt_at)
    .execute(pool)
    .await?;
    Ok(())
}

async fn candidates(
    pool: &PgPool,
    budget: u32,
) -> Result<Vec<ReleaseScheduleCandidate>, sqlx::Error> {
    sqlx::query_as::<_, ReleaseScheduleCandidate>(
        r#"SELECT
            media.id,
            media.tmdb_id,
            media.media_type,
            media.status,
            media.release_date,
            COALESCE(state.consecutive_failures, 0::smallint) AS consecutive_failures
        FROM media
        LEFT JOIN release_schedule_sync_state state ON state.media_id = media.id
        WHERE (state.next_attempt_at IS NULL OR state.next_attempt_at <= NOW())
          AND (
              (
                  media.media_type = 'tv'
                  AND EXISTS (
                      SELECT 1
                      FROM user_media tracked
                      WHERE tracked.media_id = media.id
                        AND tracked.status <> 'dropped'
                  )
              )
              OR (
                  media.media_type = 'movie'
                  AND EXISTS (
                      SELECT 1
                      FROM user_media tracked
                      WHERE tracked.media_id = media.id
                        AND tracked.status = 'plan_to_watch'
                  )
              )
          )
        ORDER BY
            CASE WHEN media.media_type = 'tv' THEN 0 ELSE 1 END,
            state.next_attempt_at NULLS FIRST,
            media.id
        LIMIT $1"#,
    )
    .bind(i64::from(budget))
    .fetch_all(pool)
    .await
}

pub async fn sync_tracked_release_schedules(
    pool: &PgPool,
    tmdb: &TmdbService,
    options: ReleaseScheduleOptions,
) -> Result<ReleaseScheduleSummary, AppError> {
    if options.budget == 0 {
        return Err(AppError::BadRequest(
            "Release schedule budget must be positive".to_string(),
        ));
    }

    let mut lock_transaction = pool.begin().await?;
    let acquired = sqlx::query_scalar::<_, bool>("SELECT pg_try_advisory_xact_lock($1)")
        .bind(RELEASE_SCHEDULE_ADVISORY_LOCK)
        .fetch_one(&mut *lock_transaction)
        .await?;
    if !acquired {
        return Ok(ReleaseScheduleSummary {
            skipped_locked: true,
            ..ReleaseScheduleSummary::default()
        });
    }

    let candidates = candidates(pool, options.budget).await?;
    let mut summary = ReleaseScheduleSummary {
        selected: candidates.len(),
        ..ReleaseScheduleSummary::default()
    };

    for (index, candidate) in candidates.iter().enumerate() {
        if index > 0 && !options.request_delay.is_zero() {
            tokio::time::sleep(options.request_delay).await;
        }

        let result = if candidate.media_type == "tv" {
            tmdb.refresh_tv_schedule(pool, candidate.tmdb_id)
                .await
                .map(|seasons| (seasons, 0))
        } else {
            let media = sqlx::query_as::<_, Media>("SELECT * FROM media WHERE id = $1")
                .bind(candidate.id)
                .fetch_one(pool)
                .await?;
            tmdb.refresh_movie_release_dates(pool, &media)
                .await
                .map(|dates| (0, dates))
        };

        match result {
            Ok((seasons, dates)) => {
                mark_success(pool, candidate).await?;
                summary.succeeded += 1;
                summary.refreshed_seasons += seasons;
                summary.cached_movie_dates += dates;
                if candidate.media_type == "tv" {
                    summary.tv_titles += 1;
                } else {
                    summary.movie_titles += 1;
                }
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

    fn candidate(
        media_type: &str,
        status: Option<&str>,
        release_date: Option<NaiveDate>,
    ) -> ReleaseScheduleCandidate {
        ReleaseScheduleCandidate {
            id: Uuid::new_v4(),
            tmdb_id: 1,
            media_type: media_type.to_string(),
            status: status.map(str::to_string),
            release_date,
            consecutive_failures: 0,
        }
    }

    #[test]
    fn retry_backoff_is_bounded() {
        assert_eq!(retry_delay("transient", 0), chrono::Duration::hours(1));
        assert_eq!(retry_delay("transient", 8), chrono::Duration::hours(24));
        assert_eq!(retry_delay("invalid", 8), chrono::Duration::days(30));
    }

    #[test]
    fn successful_refresh_cadence_matches_media_lifecycle() {
        assert_eq!(
            success_delay(&candidate("tv", Some("Returning Series"), None)),
            chrono::Duration::hours(6)
        );
        assert_eq!(
            success_delay(&candidate("tv", Some("Ended"), None)),
            chrono::Duration::days(7)
        );
        assert_eq!(
            success_delay(&candidate(
                "movie",
                Some("Released"),
                Some(Utc::now().date_naive() - chrono::Duration::days(60)),
            )),
            chrono::Duration::days(30)
        );
    }
}
