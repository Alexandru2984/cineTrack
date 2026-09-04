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

const SEASON_BACKFILL_ADVISORY_LOCK: i64 = 0x5641_5a55_5445_5342;

#[derive(Debug, Default, Eq, PartialEq)]
pub struct SeasonBackfillSummary {
    pub selected: usize,
    pub filled: usize,
    pub not_found: usize,
    pub failures: usize,
    pub skipped_locked: bool,
}

/// A season of a started show whose episodes are missing or incomplete.
#[derive(Debug, FromRow)]
pub struct SeasonBackfillCandidate {
    pub media_id: Uuid,
    pub tmdb_id: i32,
    pub season_number: i32,
}

/// Seasons of started shows whose episodes were never fetched, or were fetched
/// incompletely.
///
/// `refresh_tv_schedule` deliberately only touches the seasons near the current
/// release schedule, which is right for its job and leaves older seasons empty
/// forever. That gap is not cosmetic: `up-next` cannot name the next episode
/// while a season before it is missing, so those shows are withheld from the
/// queue until this fills them in.
///
/// Restricted to shows somebody is actually watching. A library holds seasons
/// nobody will ever open — a twenty-season reality series among them — and
/// fetching all of those would spend the whole provider budget on episodes that
/// answer no question.
const SEASON_BACKFILL_CANDIDATES: &str = r#"
    -- The shows a member has actually started, and nothing else.
    --
    -- This has to come first, and it is the whole point of the shape. The
    -- filters below cannot be pushed into an aggregate the planner cannot see
    -- through, so counting episodes before narrowing meant aggregating all
    -- 44,398 seasons against all 28,501 episodes on every run — a 38,424-row
    -- sort, 12,630 buffers, to return nothing.
    --
    -- routes/calendar.rs already carries this fix and the note explaining it;
    -- this copy of the query was simply never given the same treatment.
    -- Measured on production: 169ms to 83ms at the median, and it now grows
    -- with what people watch rather than with a catalogue that fills
    -- continuously from TMDB. A faster variant existed — 54ms — and was not
    -- taken, because it bought the difference with a plan that collapsed on a
    -- differently shaped dataset. This is an hourly job; a stable plan is worth
    -- more than thirty milliseconds.
    WITH started AS (
        SELECT DISTINCT media.id AS media_id, media.tmdb_id
        FROM user_media tracked
        JOIN media ON media.id = tracked.media_id AND media.media_type = 'tv'
        -- Somebody has started this show, so a gap can actually block a queue.
        --
        -- A LATERAL probe rather than EXISTS, and the difference is not
        -- cosmetic. Written as EXISTS the planner is free to run it the other
        -- way round — aggregate the whole of `watch_history` and hash-join
        -- outward — which is what it chose against the benchmark dataset:
        -- 64,564 rows sequentially scanned to answer a question about a few
        -- hundred. `LIMIT 1` inside a LATERAL leaves it no such choice, so this
        -- probes the index once per tracked row on any data shape.
        JOIN LATERAL (
            SELECT 1 FROM watch_history
            WHERE watch_history.user_id = tracked.user_id
              AND watch_history.media_id = tracked.media_id
            LIMIT 1
        ) AS started_probe ON TRUE
        WHERE tracked.status <> 'dropped'
    )
    SELECT started.media_id, started.tmdb_id, seasons.season_number
    FROM started
    JOIN seasons
      ON seasons.media_id = started.media_id
     AND seasons.season_number > 0
    -- How much of the season we hold, counted once per season through the
    -- index. Written as `NOT EXISTS` plus a separate `COUNT` this was faster
    -- here and fell over elsewhere: the planner hashed the `NOT EXISTS` into a
    -- sequential scan of all 28,803 episodes against the benchmark dataset,
    -- which is the shape that grows without bound. A LATERAL leaves it no
    -- choice, and the plan then holds on both.
    JOIN LATERAL (
        SELECT count(*) AS cached
        FROM episodes
        WHERE episodes.season_id = seasons.id
    ) AS held ON TRUE
    -- See the matching note in routes/calendar.rs: the cache timestamp is not
    -- the test, and `episode_count = 0` is a real answer rather than a missing
    -- one.
    WHERE (seasons.episode_count IS NULL AND held.cached = 0)
       OR (seasons.episode_count IS NOT NULL AND held.cached < seasons.episode_count)
    ORDER BY started.media_id, seasons.season_number
    LIMIT $1
"#;

/// The seasons [`backfill_incomplete_seasons`] would fetch, in the order it
/// would fetch them.
///
/// Separate from the work it feeds so the selection can be tested on its own.
/// The rules it encodes have each been wrong at least once — a season with zero
/// announced episodes read as a gap and stuck every returning show behind it —
/// and testing them through the provider round-trip means testing them barely
/// at all.
pub async fn season_backfill_candidates(
    pool: &PgPool,
    budget: u32,
) -> Result<Vec<SeasonBackfillCandidate>, AppError> {
    Ok(
        sqlx::query_as::<_, SeasonBackfillCandidate>(SEASON_BACKFILL_CANDIDATES)
            .bind(i64::from(budget))
            .fetch_all(pool)
            .await?,
    )
}

/// Fill the season gaps that keep started shows out of the Up Next queue.
///
/// Runs after the schedule sync in the same hourly job, so a viewer who marks a
/// season watched sees the correct next episode within the hour rather than
/// whenever they happen to open the season themselves.
pub async fn backfill_incomplete_seasons(
    pool: &PgPool,
    tmdb: &TmdbService,
    options: ReleaseScheduleOptions,
) -> Result<SeasonBackfillSummary, AppError> {
    if options.budget == 0 {
        return Err(AppError::BadRequest(
            "Season backfill budget must be positive".to_string(),
        ));
    }

    let mut lock_transaction = pool.begin().await?;
    let acquired = sqlx::query_scalar::<_, bool>("SELECT pg_try_advisory_xact_lock($1)")
        .bind(SEASON_BACKFILL_ADVISORY_LOCK)
        .fetch_one(&mut *lock_transaction)
        .await?;
    if !acquired {
        return Ok(SeasonBackfillSummary {
            skipped_locked: true,
            ..SeasonBackfillSummary::default()
        });
    }

    let candidates = season_backfill_candidates(pool, options.budget).await?;

    let mut summary = SeasonBackfillSummary {
        selected: candidates.len(),
        ..SeasonBackfillSummary::default()
    };

    for (index, candidate) in candidates.iter().enumerate() {
        if index > 0 && !options.request_delay.is_zero() {
            tokio::time::sleep(options.request_delay).await;
        }

        let media = match sqlx::query_as::<_, Media>("SELECT * FROM media WHERE id = $1")
            .bind(candidate.media_id)
            .fetch_optional(pool)
            .await?
        {
            Some(media) => media,
            // Deleted between selection and now; nothing to fill.
            None => continue,
        };

        match tmdb
            .refresh_season_episodes(pool, &media, candidate.season_number)
            .await
        {
            Ok(_) => summary.filled += 1,
            // The provider has no such season. Common for a placeholder season
            // row the show metadata announced before it existed; retrying every
            // hour would be pointless, and it blocks nothing, because a season
            // that does not exist cannot hide an episode.
            Err(AppError::NotFound(_)) => {
                summary.not_found += 1;
                log::debug!(
                    "season backfill: provider has no season tmdb_id={} season={}",
                    candidate.tmdb_id,
                    candidate.season_number
                );
            }
            Err(error @ (AppError::DatabaseError(_) | AppError::InternalError(_))) => {
                return Err(error);
            }
            Err(error) => {
                summary.failures += 1;
                log::warn!(
                    "season backfill failed tmdb_id={} season={}: {error}",
                    candidate.tmdb_id,
                    candidate.season_number
                );
            }
        }
    }

    Ok(summary)
}

#[derive(Clone, Debug, FromRow)]
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

/// Record a successful refresh and decide when to come back.
///
/// The cadence is computed from the status the refresh just wrote, not the one
/// the candidate was loaded with. Those differ exactly when it matters most: a
/// series that has gone from `Ended` back to `Returning Series` was selected
/// carrying the old status, and deciding on that gave it the seven-day
/// ended-series cadence at the moment it started airing again. `Harley Quinn`
/// sat on a seven-day interval that way with `Returning Series` in the same
/// row, so new episodes could arrive in the calendar up to a week late.
///
/// One extra read per refreshed title, against a provider call that has just
/// happened anyway.
async fn mark_success(
    pool: &PgPool,
    candidate: &ReleaseScheduleCandidate,
) -> Result<(), sqlx::Error> {
    let refreshed = sqlx::query_as::<_, (Option<String>, Option<NaiveDate>)>(
        "SELECT status, release_date FROM media WHERE id = $1",
    )
    .bind(candidate.id)
    .fetch_optional(pool)
    .await?;
    let candidate = match refreshed {
        Some((status, release_date)) => ReleaseScheduleCandidate {
            status,
            release_date,
            ..candidate.clone()
        },
        // The title vanished between the refresh and here. Nothing to reschedule
        // against but what we already had.
        None => candidate.clone(),
    };
    let next_attempt_at = Utc::now() + success_delay(&candidate);
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
