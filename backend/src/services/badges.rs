//! Badges earned from watch history.
//!
//! # What is measured, and what is deliberately not
//!
//! The badges here describe *how somebody watches*: runs of episodes in a
//! sitting, keeping up with a show as it airs, following several at once. They
//! are all derivable from watch history, which means they can be recomputed
//! from scratch and audited against the thing they claim to describe.
//!
//! The app this replaces also awarded badges for opening the web version,
//! viewing a profile, and picking an emotion. Those are rewards for using the
//! product rather than statements about the person using it, and a shelf full
//! of them makes the real ones worth less. None of them are here.
//!
//! # Recomputed, never incremented
//!
//! Every badge is derived from the current history each time. History is
//! imported in bulk, edited, and corrected; a counter bumped per watch drifts
//! away from it and cannot be explained afterwards. Recomputing costs a few
//! set-based queries and can never disagree with the history it summarises.

use sqlx::PgPool;
use uuid::Uuid;

/// Whether a badge describes one show or the whole account.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    Show,
    Account,
}

pub struct Badge {
    pub key: &'static str,
    pub family: &'static str,
    pub threshold: i64,
    pub scope: Scope,
}

/// Tiers are chosen to mean something at both ends of this app's range: a
/// member who has watched a dozen episodes should be able to earn one, and a
/// member with thirty-five thousand should still have something left.
pub const BADGES: &[Badge] = &[
    // A run of episodes of one show in a sitting. Twenty-four hours for the
    // small tiers, forty-eight for the large ones, because twenty episodes in
    // a single day is not a marathon, it is a data-entry session.
    Badge {
        key: "marathon-3",
        family: "marathon24",
        threshold: 3,
        scope: Scope::Show,
    },
    Badge {
        key: "marathon-5",
        family: "marathon24",
        threshold: 5,
        scope: Scope::Show,
    },
    Badge {
        key: "marathon-10",
        family: "marathon48",
        threshold: 10,
        scope: Scope::Show,
    },
    Badge {
        key: "marathon-20",
        family: "marathon48",
        threshold: 20,
        scope: Scope::Show,
    },
    // Episodes watched within a day of becoming available. This is the badge
    // that needed the origin network's clock: with a bare air date there is no
    // moment to count from.
    Badge {
        key: "same-day-3",
        family: "sameday",
        threshold: 3,
        scope: Scope::Show,
    },
    Badge {
        key: "same-day-5",
        family: "sameday",
        threshold: 5,
        scope: Scope::Show,
    },
    Badge {
        key: "same-day-10",
        family: "sameday",
        threshold: 10,
        scope: Scope::Show,
    },
    Badge {
        key: "same-day-25",
        family: "sameday",
        threshold: 25,
        scope: Scope::Show,
    },
    // Shows being watched at the same time.
    Badge {
        key: "juggler-3",
        family: "juggler",
        threshold: 3,
        scope: Scope::Account,
    },
    Badge {
        key: "juggler-8",
        family: "juggler",
        threshold: 8,
        scope: Scope::Account,
    },
    Badge {
        key: "juggler-15",
        family: "juggler",
        threshold: 15,
        scope: Scope::Account,
    },
    // Sheer volume.
    Badge {
        key: "watcher-50",
        family: "volume",
        threshold: 50,
        scope: Scope::Account,
    },
    Badge {
        key: "watcher-250",
        family: "volume",
        threshold: 250,
        scope: Scope::Account,
    },
    Badge {
        key: "watcher-1000",
        family: "volume",
        threshold: 1000,
        scope: Scope::Account,
    },
    Badge {
        key: "watcher-5000",
        family: "volume",
        threshold: 5000,
        scope: Scope::Account,
    },
];

/// Rebuild badges for one account from its history.
///
/// One statement, and a rewrite rather than a merge: badges state what is
/// currently true of a history, so an episode removed can take one away.
/// `earned_at` comes from the history itself — the watch that first satisfied
/// the badge — so recomputing never makes an old achievement look new.
///
/// `media_id` narrows the per-show work. Marking one episode can only change
/// badges for that show, and rebuilding every show's marathons costs about
/// forty milliseconds per family on an account with seventeen thousand watches
/// — paid on every single watch, for an answer that cannot have changed.
/// Account-wide families are always rebuilt: they are counts, and cheap.
///
/// Pass `None` after an import or anything else that rewrites history broadly.
///
/// This used to collect the candidates in a temporary table. The application
/// role has no TEMP privilege — `scripts/provision_db_role.sh` removes it on
/// purpose — so in production every recompute failed from the day it shipped,
/// quietly, through `recompute_quietly`, and no badge was earned after the
/// backfill migration that first awarded them. The candidates are now a CTE;
/// the delete and the insert read it inside the same statement, which is
/// atomic on its own.
pub async fn recompute(
    pool: &PgPool,
    user_id: Uuid,
    media_id: Option<Uuid>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        WITH
        -- Runs of one show inside a rolling window. A window function walks the
        -- history once; asking per show would be a query per tracked title, and
        -- some accounts here track more than a thousand.
        runs AS (
            SELECT
                media_id,
                watched_at,
                COUNT(*) OVER (
                    PARTITION BY media_id ORDER BY watched_at
                    RANGE BETWEEN INTERVAL '24 hours' PRECEDING AND CURRENT ROW
                ) AS in_24h,
                COUNT(*) OVER (
                    PARTITION BY media_id ORDER BY watched_at
                    RANGE BETWEEN INTERVAL '48 hours' PRECEDING AND CURRENT ROW
                ) AS in_48h
            FROM watch_history
            WHERE user_id = $1
              AND episode_id IS NOT NULL
              AND ($2::uuid IS NULL OR media_id = $2)
        ),
        marathon_tiers (badge_key, window_hours, threshold) AS (
            VALUES ('marathon-3', 24, 3),
                   ('marathon-5', 24, 5),
                   ('marathon-10', 48, 10),
                   ('marathon-20', 48, 20)
        ),
        marathons AS (
            SELECT marathon_tiers.badge_key, runs.media_id, MIN(runs.watched_at) AS earned_at
            FROM runs
            JOIN marathon_tiers
              ON (marathon_tiers.window_hours = 24 AND runs.in_24h >= marathon_tiers.threshold)
              OR (marathon_tiers.window_hours = 48 AND runs.in_48h >= marathon_tiers.threshold)
            GROUP BY marathon_tiers.badge_key, runs.media_id
        ),
        -- Episodes watched within a day of becoming available, per show.
        --
        -- Only an upper bound is applied, not a lower one. Going forward the
        -- server refuses to record a watch before an episode has aired, so
        -- "earlier than available" can only come from imported history, where
        -- the origin clock we compute may sit a few hours after whatever clock
        -- the old service used. Discarding those would quietly punish people
        -- for importing.
        prompt AS (
            SELECT
                seasons.media_id,
                history.watched_at,
                ROW_NUMBER() OVER (
                    PARTITION BY seasons.media_id ORDER BY history.watched_at
                ) AS nth
            FROM watch_history history
            JOIN episodes ON episodes.id = history.episode_id
            JOIN seasons ON seasons.id = episodes.season_id
            JOIN media ON media.id = seasons.media_id
            WHERE history.user_id = $1
              AND ($2::uuid IS NULL OR seasons.media_id = $2)
              AND episodes.air_date IS NOT NULL
              AND history.watched_at
                  < episode_available_at(episodes.air_date, media.origin_country)
                    + INTERVAL '24 hours'
        ),
        same_day_tiers (badge_key, threshold) AS (
            VALUES ('same-day-3', 3), ('same-day-5', 5),
                   ('same-day-10', 10), ('same-day-25', 25)
        ),
        same_day AS (
            SELECT same_day_tiers.badge_key, prompt.media_id, prompt.watched_at AS earned_at
            FROM prompt
            JOIN same_day_tiers ON same_day_tiers.threshold = prompt.nth
        ),
        -- Shows being watched at once, dated by when the Nth of them was
        -- started.
        --
        -- Counted rather than ranked. `ROW_NUMBER()` over the whole set has to
        -- sort it; a count plus one offset lookup per tier reads an index and
        -- stops.
        watching AS (
            SELECT COUNT(*) AS reached
            FROM user_media
            WHERE user_id = $1 AND status = 'watching'
        ),
        juggler_tiers (badge_key, threshold) AS (
            VALUES ('juggler-3', 3), ('juggler-8', 8), ('juggler-15', 15)
        ),
        jugglers AS (
            SELECT juggler_tiers.badge_key, NULL::uuid AS media_id, crossed.created_at AS earned_at
            FROM juggler_tiers
            JOIN watching ON watching.reached >= juggler_tiers.threshold
            CROSS JOIN LATERAL (
                SELECT created_at
                FROM user_media
                WHERE user_id = $1 AND status = 'watching'
                ORDER BY created_at
                OFFSET juggler_tiers.threshold - 1
                LIMIT 1
            ) AS crossed
        ),
        -- Sheer volume, dated by the episode that crossed each line.
        --
        -- This one mattered most. Ranking every watch to find four timestamps
        -- cost 147ms on an account with seventeen thousand of them — paid on
        -- every episode marked watched, and growing with the history it
        -- summarises. The count is 5ms and each offset lookup 1ms, because both
        -- read the index in order and stop.
        watched AS (
            SELECT COUNT(*) AS reached
            FROM watch_history
            WHERE user_id = $1 AND episode_id IS NOT NULL
        ),
        watcher_tiers (badge_key, threshold) AS (
            VALUES ('watcher-50', 50), ('watcher-250', 250),
                   ('watcher-1000', 1000), ('watcher-5000', 5000)
        ),
        watchers AS (
            SELECT watcher_tiers.badge_key, NULL::uuid AS media_id, crossed.watched_at AS earned_at
            FROM watcher_tiers
            JOIN watched ON watched.reached >= watcher_tiers.threshold
            CROSS JOIN LATERAL (
                SELECT watched_at
                FROM watch_history
                WHERE user_id = $1 AND episode_id IS NOT NULL
                ORDER BY watched_at
                OFFSET watcher_tiers.threshold - 1
                LIMIT 1
            ) AS crossed
        ),
        earned AS (
            SELECT badge_key, media_id, earned_at FROM marathons
            UNION ALL SELECT badge_key, media_id, earned_at FROM same_day
            UNION ALL SELECT badge_key, media_id, earned_at FROM jugglers
            UNION ALL SELECT badge_key, media_id, earned_at FROM watchers
        ),
        -- Anything the history no longer supports goes. This is the half that
        -- makes recomputing meaningful rather than merely idempotent.
        unsupported AS (
            DELETE FROM user_badges
            WHERE user_id = $1
              -- Only rows this run actually recomputed. Without it, narrowing
              -- to one show would delete every other show's badges as
              -- unsupported.
              AND ($2::uuid IS NULL OR media_id IS NULL OR media_id = $2)
              AND NOT EXISTS (
                  SELECT 1 FROM earned candidate
                  WHERE candidate.badge_key = user_badges.badge_key
                    AND candidate.media_id IS NOT DISTINCT FROM user_badges.media_id
              )
        )
        INSERT INTO user_badges (user_id, badge_key, media_id, earned_at)
        SELECT $1, badge_key, media_id, earned_at FROM earned
        ON CONFLICT (user_id, badge_key, COALESCE(media_id, '00000000-0000-0000-0000-000000000000'::uuid))
        DO NOTHING
        "#,
    )
    .bind(user_id)
    .bind(media_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Recompute every account's badges. Returns how many accounts were done.
///
/// For catching up after recomputing has been unable to run, as it was from
/// August to October 2026: badges only move when somebody records a watch, so
/// anyone who has not since would keep the shelf they had when it broke.
pub async fn recompute_everyone(pool: &PgPool) -> Result<usize, sqlx::Error> {
    let users = sqlx::query_scalar::<_, Uuid>(
        "SELECT DISTINCT user_id FROM watch_history ORDER BY user_id",
    )
    .fetch_all(pool)
    .await?;
    for user_id in &users {
        recompute(pool, *user_id, None).await?;
    }
    Ok(users.len())
}

/// The best value a member currently has in each family, for progress.
///
/// Deliberately recomputed from history rather than read from `user_badges`:
/// the table records thresholds crossed, not how far past the last one somebody
/// is, and a progress bar built from earned rows could only ever show 0% or
/// 100%.
pub async fn family_standings(
    pool: &PgPool,
    user_id: Uuid,
) -> Result<Vec<(String, i64)>, sqlx::Error> {
    sqlx::query_as::<_, (String, i64)>(
        r#"
        WITH runs AS (
            SELECT
                COUNT(*) OVER (
                    PARTITION BY media_id ORDER BY watched_at
                    RANGE BETWEEN INTERVAL '24 hours' PRECEDING AND CURRENT ROW
                ) AS in_24h,
                COUNT(*) OVER (
                    PARTITION BY media_id ORDER BY watched_at
                    RANGE BETWEEN INTERVAL '48 hours' PRECEDING AND CURRENT ROW
                ) AS in_48h
            FROM watch_history
            WHERE user_id = $1 AND episode_id IS NOT NULL
        ),
        prompt AS (
            SELECT seasons.media_id, COUNT(*) AS total
            FROM watch_history history
            JOIN episodes ON episodes.id = history.episode_id
            JOIN seasons ON seasons.id = episodes.season_id
            JOIN media ON media.id = seasons.media_id
            WHERE history.user_id = $1
              AND episodes.air_date IS NOT NULL
              AND history.watched_at
                  < episode_available_at(episodes.air_date, media.origin_country)
                    + INTERVAL '24 hours'
            GROUP BY seasons.media_id
        )
        SELECT 'marathon24', COALESCE(MAX(in_24h), 0) FROM runs
        UNION ALL
        SELECT 'marathon48', COALESCE(MAX(in_48h), 0) FROM runs
        UNION ALL
        SELECT 'sameday', COALESCE(MAX(total), 0) FROM prompt
        UNION ALL
        SELECT 'juggler', COUNT(*) FROM user_media
            WHERE user_id = $1 AND status = 'watching'
        UNION ALL
        SELECT 'volume', COUNT(*) FROM watch_history
            WHERE user_id = $1 AND episode_id IS NOT NULL
        "#,
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
}

/// Recompute without letting a failure reach the caller.
///
/// A badge is a decoration on an action that has already succeeded. Failing to
/// award one must never turn a recorded episode into an error, the same rule
/// the completion service follows.
pub async fn recompute_quietly(pool: &PgPool, user_id: Uuid, media_id: Option<Uuid>) {
    if let Err(error) = recompute(pool, user_id, media_id).await {
        // Logged as an error, not a warning: the caller carries on, but a
        // failure here is a bug, and errors are what the alert rules count.
        log::error!("badge recompute failed user_id={user_id} error={error}");
    }
}
