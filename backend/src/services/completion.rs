//! Promote a tracked show to `completed` once there is nothing left to watch.
//!
//! Only shows TMDB reports as finished qualify. A returning series whose aired
//! episodes are all watched is *caught up*, not completed — next week there is
//! another episode, and flipping it to completed would only flip it back.
//!
//! This runs after an episode is recorded as watched. It is deliberately
//! best-effort: failing to award a badge must never fail the watch itself.

use sqlx::PgPool;
use uuid::Uuid;

/// TMDB's terminal states. Anything else means more episodes may still arrive.
const FINISHED_SHOW_STATES: [&str; 2] = ["Ended", "Canceled"];

/// Mark the show completed if it has finished airing and the user has watched
/// every aired episode. Returns whether the row was promoted.
pub async fn complete_show_if_fully_watched(
    pool: &PgPool,
    user_id: Uuid,
    media_id: Uuid,
) -> Result<bool, sqlx::Error> {
    let promoted = sqlx::query(
        r#"
        UPDATE user_media um
        SET status = 'completed',
            -- The table requires completed_at >= started_at; GREATEST ignores a
            -- NULL start, so this stays valid either way.
            completed_at = GREATEST(CURRENT_DATE, um.started_at),
            updated_at = NOW()
        FROM media m
        WHERE um.user_id = $1
          AND um.media_id = $2
          AND m.id = um.media_id
          AND m.media_type = 'tv'
          AND m.status = ANY($3)
          AND um.status <> 'completed'
          -- Specials (season 0) are optional viewing, so they never block this.
          AND EXISTS (
              SELECT 1 FROM seasons s
              JOIN episodes e ON e.season_id = s.id
              WHERE s.media_id = m.id AND s.season_number > 0
          )
          AND NOT EXISTS (
              SELECT 1 FROM seasons s
              JOIN episodes e ON e.season_id = s.id
              WHERE s.media_id = m.id
                AND s.season_number > 0
                AND e.air_date IS NOT NULL
                AND e.air_date <= CURRENT_DATE
                AND NOT EXISTS (
                    SELECT 1 FROM watch_history wh
                    WHERE wh.user_id = um.user_id AND wh.episode_id = e.id
                )
          )
        "#,
    )
    .bind(user_id)
    .bind(media_id)
    .bind(&FINISHED_SHOW_STATES[..])
    .execute(pool)
    .await?
    .rows_affected();

    if promoted > 0 {
        log::info!("tracking: show completed user_id={user_id} media_id={media_id}");
    }
    Ok(promoted > 0)
}

/// Same check, but never propagates an error: awarding the badge is a side
/// effect of watching an episode and must not turn a successful watch into a
/// failed request.
pub async fn complete_show_if_fully_watched_best_effort(
    pool: &PgPool,
    user_id: Uuid,
    media_id: Uuid,
) {
    if let Err(error) = complete_show_if_fully_watched(pool, user_id, media_id).await {
        log::warn!(
            "failed to evaluate show completion user_id={user_id} media_id={media_id}: {error}"
        );
    }
}
