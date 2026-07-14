use actix_web::{web, HttpRequest, HttpResponse};
use chrono::{DateTime, Utc};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::dto::calendar::*;
use crate::errors::AppError;
use crate::middleware::auth::require_auth;
use crate::services::quota;

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::scope("/calendar")
            .route("/new", web::get().to(new_episodes))
            .route("/upcoming", web::get().to(upcoming_releases))
            .route("/summary", web::get().to(calendar_summary))
            .route("/preferences", web::get().to(get_preferences))
            .route("/preferences", web::put().to(update_preferences))
            .route("/episodes/{episode_id}/plan", web::put().to(plan_episode))
            .route(
                "/episodes/{episode_id}/plan",
                web::delete().to(unplan_episode),
            )
            .route(
                "/episodes/{episode_id}/watched",
                web::post().to(mark_episode_watched),
            ),
    );
}

async fn new_episodes(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    query: web::Query<NewCalendarQuery>,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    let params = query.resolve()?;
    let (before_date, before_id) = params
        .cursor
        .map_or((None, None), |(date, id)| (Some(date), Some(id)));
    let mut items = sqlx::query_as::<_, CalendarEpisode>(
        r#"SELECT
            episodes.id AS episode_id,
            media.id AS media_id,
            media.tmdb_id,
            media.title,
            media.poster_path,
            seasons.season_number,
            episodes.episode_number,
            episodes.name AS episode_name,
            episodes.overview,
            episodes.runtime_minutes,
            episodes.air_date,
            episodes.still_path,
            EXISTS (
                SELECT 1 FROM episode_plans plans
                WHERE plans.user_id = $1 AND plans.episode_id = episodes.id
            ) AS is_planned
        FROM user_media tracked
        JOIN media ON media.id = tracked.media_id AND media.media_type = 'tv'
        JOIN seasons ON seasons.media_id = media.id
        JOIN episodes ON episodes.season_id = seasons.id
        WHERE tracked.user_id = $1
          AND tracked.status <> 'dropped'
          AND episodes.air_date <= $2
          AND ($6 OR seasons.season_number > 0)
          AND (
              episodes.air_date >= $2 - $3
              OR EXISTS (
                  SELECT 1 FROM episode_plans plans
                  WHERE plans.user_id = $1 AND plans.episode_id = episodes.id
              )
          )
          AND NOT EXISTS (
              SELECT 1 FROM watch_history history
              WHERE history.user_id = $1 AND history.episode_id = episodes.id
          )
          AND (
              $4::date IS NULL
              OR (episodes.air_date, episodes.id) < ($4, $5)
          )
        ORDER BY episodes.air_date DESC, episodes.id DESC
        LIMIT $7"#,
    )
    .bind(user_id)
    .bind(params.today)
    .bind(params.days)
    .bind(before_date)
    .bind(before_id)
    .bind(params.include_specials)
    .bind(params.limit + 1)
    .fetch_all(pool.get_ref())
    .await?;

    let has_more = items.len() > params.limit as usize;
    items.truncate(params.limit as usize);
    let next_cursor = has_more
        .then(|| items.last())
        .flatten()
        .map(|last| EpisodeCursor {
            before_date: last.air_date,
            before_id: last.episode_id,
        });

    Ok(HttpResponse::Ok().json(CalendarEpisodePage { items, next_cursor }))
}

async fn upcoming_releases(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    query: web::Query<UpcomingCalendarQuery>,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    let params = query.resolve()?;
    let country_code = calendar_country(pool.get_ref(), user_id).await?;
    let cutoff = params.today + chrono::Duration::days(i64::from(params.days));
    let (after_date, after_kind, after_key) = params
        .cursor
        .map_or((None, None, None), |(date, kind, key)| {
            (Some(date), Some(kind), Some(key))
        });

    let mut items = sqlx::query_as::<_, UpcomingCalendarItem>(
        r#"WITH episode_items AS (
            SELECT
                'episode'::text AS item_kind,
                episodes.id AS item_id,
                media.id AS media_id,
                media.tmdb_id,
                media.title,
                media.poster_path,
                episodes.air_date AS release_date,
                NULL::smallint AS release_type,
                seasons.season_number,
                episodes.episode_number,
                episodes.name AS episode_name,
                episodes.still_path,
                EXISTS (
                    SELECT 1 FROM episode_plans plans
                    WHERE plans.user_id = $1 AND plans.episode_id = episodes.id
                ) AS is_planned,
                episodes.id::text AS sort_key
            FROM user_media tracked
            JOIN media ON media.id = tracked.media_id AND media.media_type = 'tv'
            JOIN seasons ON seasons.media_id = media.id
            JOIN episodes ON episodes.season_id = seasons.id
            WHERE tracked.user_id = $1
              AND tracked.status <> 'dropped'
              AND episodes.air_date > $2
              AND episodes.air_date <= $3
              AND ($9 OR seasons.season_number > 0)
        ),
        regional_movie_items AS (
            SELECT DISTINCT ON (media.id, dates.release_type)
                'movie'::text AS item_kind,
                media.id AS item_id,
                media.id AS media_id,
                media.tmdb_id,
                media.title,
                media.poster_path,
                dates.release_date,
                dates.release_type,
                NULL::integer AS season_number,
                NULL::integer AS episode_number,
                NULL::varchar AS episode_name,
                NULL::text AS still_path,
                FALSE AS is_planned,
                media.id::text || ':' || dates.release_type::text AS sort_key
            FROM user_media tracked
            JOIN media ON media.id = tracked.media_id AND media.media_type = 'movie'
            JOIN media_release_dates dates
              ON dates.media_id = media.id AND dates.country_code = $4
            WHERE tracked.user_id = $1
              AND tracked.status = 'plan_to_watch'
              AND dates.release_date > $2
              AND dates.release_date <= $3
            ORDER BY media.id, dates.release_type, dates.release_date
        ),
        fallback_movie_items AS (
            SELECT
                'movie'::text AS item_kind,
                media.id AS item_id,
                media.id AS media_id,
                media.tmdb_id,
                media.title,
                media.poster_path,
                media.release_date,
                NULL::smallint AS release_type,
                NULL::integer AS season_number,
                NULL::integer AS episode_number,
                NULL::varchar AS episode_name,
                NULL::text AS still_path,
                FALSE AS is_planned,
                media.id::text || ':fallback' AS sort_key
            FROM user_media tracked
            JOIN media ON media.id = tracked.media_id AND media.media_type = 'movie'
            WHERE tracked.user_id = $1
              AND tracked.status = 'plan_to_watch'
              AND media.release_date > $2
              AND media.release_date <= $3
              AND NOT EXISTS (
                  SELECT 1 FROM media_release_dates dates
                  WHERE dates.media_id = media.id AND dates.country_code = $4
              )
        ),
        calendar_items AS (
            SELECT * FROM episode_items
            UNION ALL
            SELECT * FROM regional_movie_items
            UNION ALL
            SELECT * FROM fallback_movie_items
        )
        SELECT *
        FROM calendar_items
        WHERE ($8 = 'all' OR item_kind = $8)
          AND (
              $5::date IS NULL
              OR (release_date, item_kind, sort_key) > ($5, $6, $7)
          )
        ORDER BY release_date, item_kind, sort_key
        LIMIT $10"#,
    )
    .bind(user_id)
    .bind(params.today)
    .bind(cutoff)
    .bind(&country_code)
    .bind(after_date)
    .bind(after_kind)
    .bind(after_key)
    .bind(&params.item_kind)
    .bind(params.include_specials)
    .bind(params.limit + 1)
    .fetch_all(pool.get_ref())
    .await?;

    let has_more = items.len() > params.limit as usize;
    items.truncate(params.limit as usize);
    let next_cursor = has_more
        .then(|| items.last())
        .flatten()
        .map(|last| UpcomingCursor {
            after_date: last.release_date,
            after_kind: last.item_kind.clone(),
            after_key: last.sort_key.clone(),
        });

    Ok(HttpResponse::Ok().json(UpcomingCalendarPage {
        items,
        next_cursor,
        country_code,
    }))
}

async fn calendar_summary(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    query: web::Query<NewCalendarQuery>,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    let params = query.resolve()?;
    let (new_count, planned_count, last_synced_at) =
        sqlx::query_as::<_, (i64, i64, Option<DateTime<Utc>>)>(
            r#"SELECT
                (
                    SELECT COUNT(DISTINCT episodes.id)
                    FROM user_media tracked
                    JOIN media ON media.id = tracked.media_id AND media.media_type = 'tv'
                    JOIN seasons ON seasons.media_id = media.id
                    JOIN episodes ON episodes.season_id = seasons.id
                    WHERE tracked.user_id = $1
                      AND tracked.status <> 'dropped'
                      AND ($4 OR seasons.season_number > 0)
                      AND episodes.air_date BETWEEN $2 - $3 AND $2
                      AND NOT EXISTS (
                          SELECT 1 FROM watch_history history
                          WHERE history.user_id = $1 AND history.episode_id = episodes.id
                      )
                ),
                (
                    SELECT COUNT(*)
                    FROM episode_plans plans
                    JOIN episodes ON episodes.id = plans.episode_id
                    JOIN seasons ON seasons.id = episodes.season_id
                    JOIN user_media tracked
                      ON tracked.media_id = seasons.media_id AND tracked.user_id = $1
                    WHERE plans.user_id = $1
                      AND tracked.status <> 'dropped'
                      AND ($4 OR seasons.season_number > 0)
                      AND NOT EXISTS (
                          SELECT 1 FROM watch_history history
                          WHERE history.user_id = $1 AND history.episode_id = plans.episode_id
                      )
                ),
                (
                    SELECT MAX(state.last_success_at)
                    FROM release_schedule_sync_state state
                    JOIN user_media tracked
                      ON tracked.media_id = state.media_id AND tracked.user_id = $1
                    WHERE tracked.status <> 'dropped'
                )"#,
        )
        .bind(user_id)
        .bind(params.today)
        .bind(params.days)
        .bind(params.include_specials)
        .fetch_one(pool.get_ref())
        .await?;

    Ok(HttpResponse::Ok().json(CalendarSummary {
        new_count,
        planned_count,
        last_synced_at,
    }))
}

async fn get_preferences(
    pool: web::Data<PgPool>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    Ok(HttpResponse::Ok().json(CalendarPreferences {
        country_code: calendar_country(pool.get_ref(), user_id).await?,
    }))
}

async fn update_preferences(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    body: web::Json<UpdateCalendarPreferencesRequest>,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    let country_code = body.normalized_country_code()?;
    sqlx::query(
        r#"INSERT INTO user_calendar_preferences (user_id, country_code)
        VALUES ($1, $2)
        ON CONFLICT (user_id) DO UPDATE SET
            country_code = EXCLUDED.country_code,
            updated_at = NOW()"#,
    )
    .bind(user_id)
    .bind(&country_code)
    .execute(pool.get_ref())
    .await?;
    Ok(HttpResponse::Ok().json(CalendarPreferences { country_code }))
}

async fn calendar_country(pool: &PgPool, user_id: Uuid) -> Result<String, AppError> {
    Ok(sqlx::query_scalar::<_, String>(
        "SELECT COALESCE((SELECT country_code FROM user_calendar_preferences WHERE user_id = $1), 'RO')",
    )
    .bind(user_id)
    .fetch_one(pool)
    .await?)
}

async fn plan_episode(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<Uuid>,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    let episode_id = path.into_inner();
    let mut tx = pool.begin().await?;
    lock_episode_state(&mut tx, user_id, episode_id).await?;
    ensure_tracked_episode(&mut tx, user_id, episode_id).await?;
    quota::lock_history_writes(&mut tx, user_id).await?;

    let watched = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM watch_history WHERE user_id = $1 AND episode_id = $2)",
    )
    .bind(user_id)
    .bind(episode_id)
    .fetch_one(&mut *tx)
    .await?;
    if watched {
        return Err(AppError::Conflict("Episode is already watched".to_string()));
    }

    let plan_count = quota::lock_and_count_episode_plans(&mut tx, user_id).await?;
    let already_planned = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM episode_plans WHERE user_id = $1 AND episode_id = $2)",
    )
    .bind(user_id)
    .bind(episode_id)
    .fetch_one(&mut *tx)
    .await?;
    quota::ensure_episode_plan_capacity(plan_count, if already_planned { 0 } else { 1 })?;
    let inserted = sqlx::query(
        r#"INSERT INTO episode_plans (user_id, episode_id)
        VALUES ($1, $2)
        ON CONFLICT DO NOTHING"#,
    )
    .bind(user_id)
    .bind(episode_id)
    .execute(&mut *tx)
    .await?
    .rows_affected()
        == 1;
    tx.commit().await?;

    let status = if inserted {
        actix_web::http::StatusCode::CREATED
    } else {
        actix_web::http::StatusCode::OK
    };
    Ok(HttpResponse::build(status).json(serde_json::json!({
        "episode_id": episode_id,
        "planned": true,
        "already_planned": !inserted,
    })))
}

async fn unplan_episode(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<Uuid>,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    let episode_id = path.into_inner();
    let mut tx = pool.begin().await?;
    lock_episode_state(&mut tx, user_id, episode_id).await?;
    sqlx::query("DELETE FROM episode_plans WHERE user_id = $1 AND episode_id = $2")
        .bind(user_id)
        .bind(episode_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({
        "episode_id": episode_id,
        "planned": false,
    })))
}

async fn mark_episode_watched(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<Uuid>,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    let episode_id = path.into_inner();
    let mut tx = pool.begin().await?;
    lock_episode_state(&mut tx, user_id, episode_id).await?;
    quota::lock_tracking_writes(&mut tx, user_id).await?;
    let media_id = ensure_tracked_episode(&mut tx, user_id, episode_id).await?;
    let history_count = quota::lock_and_count_history(&mut tx, user_id).await?;
    let existing_history_id = sqlx::query_scalar::<_, Uuid>(
        r#"SELECT id FROM watch_history
        WHERE user_id = $1 AND media_id = $2 AND episode_id = $3
        ORDER BY watched_at, id
        LIMIT 1"#,
    )
    .bind(user_id)
    .bind(media_id)
    .bind(episode_id)
    .fetch_optional(&mut *tx)
    .await?;

    let (history_id, already_watched) = if let Some(history_id) = existing_history_id {
        (history_id, true)
    } else {
        quota::ensure_history_capacity(history_count, 1)?;
        let history_id = sqlx::query_scalar::<_, Uuid>(
            r#"INSERT INTO watch_history (user_id, media_id, episode_id, watched_at)
            VALUES ($1, $2, $3, NOW())
            RETURNING id"#,
        )
        .bind(user_id)
        .bind(media_id)
        .bind(episode_id)
        .fetch_one(&mut *tx)
        .await?;
        (history_id, false)
    };

    sqlx::query("DELETE FROM episode_plans WHERE user_id = $1 AND episode_id = $2")
        .bind(user_id)
        .bind(episode_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        r#"UPDATE user_media
        SET status = CASE WHEN status = 'plan_to_watch' THEN 'watching' ELSE status END,
            started_at = COALESCE(started_at, CURRENT_DATE),
            updated_at = NOW()
        WHERE user_id = $1 AND media_id = $2"#,
    )
    .bind(user_id)
    .bind(media_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    let status = if already_watched {
        actix_web::http::StatusCode::OK
    } else {
        actix_web::http::StatusCode::CREATED
    };
    Ok(HttpResponse::build(status).json(serde_json::json!({
        "history_id": history_id,
        "media_id": media_id,
        "episode_id": episode_id,
        "already_watched": already_watched,
    })))
}

async fn lock_episode_state(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    episode_id: Uuid,
) -> Result<(), AppError> {
    sqlx::query(
        "SELECT pg_advisory_xact_lock(hashtextextended('episode-state:' || $1::text || ':' || $2::text, 0))",
    )
    .bind(user_id)
    .bind(episode_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn ensure_tracked_episode(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    episode_id: Uuid,
) -> Result<Uuid, AppError> {
    sqlx::query_scalar::<_, Uuid>(
        r#"SELECT seasons.media_id
        FROM episodes
        JOIN seasons ON seasons.id = episodes.season_id
        JOIN media ON media.id = seasons.media_id AND media.media_type = 'tv'
        JOIN user_media tracked
          ON tracked.media_id = media.id AND tracked.user_id = $1
        WHERE episodes.id = $2 AND tracked.status <> 'dropped'"#,
    )
    .bind(user_id)
    .bind(episode_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| AppError::NotFound("Episode not found in your tracked shows".to_string()))
}
