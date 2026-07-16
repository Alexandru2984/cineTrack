use actix_web::{web, HttpRequest, HttpResponse};
use futures_util::stream::{self, StreamExt, TryStreamExt};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::dto::common::PaginationParams;
use crate::dto::tracking::*;
use crate::errors::AppError;
use crate::middleware::auth::require_auth;
use crate::models::Media;
use crate::services::quota;
use crate::services::tmdb::TmdbService;

const MAX_BULK_SEASONS: usize = 100;
const MAX_BULK_EPISODES: usize = 10_000;
const BULK_SEASON_CACHE_CONCURRENCY: usize = 2;

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::scope("/history")
            .route("", web::get().to(list_history))
            .route("", web::post().to(create_history))
            .route(
                "/tv/{tmdb_id}/seasons/{season_number}/episodes",
                web::get().to(list_watched_episodes),
            )
            .route("/tv/{tmdb_id}/progress", web::get().to(show_watch_progress))
            .route(
                "/tv/{tmdb_id}/seasons/{season_number}/watched",
                web::post().to(mark_season_watched),
            )
            .route(
                "/tv/{tmdb_id}/seasons/{season_number}/episodes/{episode_number}/watched-through",
                web::post().to(mark_episodes_watched_through),
            )
            .route(
                "/tv/{tmdb_id}/seasons/{season_number}/episodes/{episode_number}/watched",
                web::post().to(mark_episode_watched),
            )
            .route("/{id}", web::delete().to(delete_history)),
    );
}

fn validate_episode_path(
    tmdb_id: i32,
    season_number: i32,
    episode_number: Option<i32>,
) -> Result<(), AppError> {
    if tmdb_id <= 0 || !(0..=500).contains(&season_number) {
        return Err(AppError::BadRequest(
            "Invalid TMDB ID or season number".to_string(),
        ));
    }
    if episode_number.is_some_and(|number| !(1..=100_000).contains(&number)) {
        return Err(AppError::BadRequest("Invalid episode number".to_string()));
    }
    Ok(())
}

async fn list_history(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    pagination: web::Query<PaginationParams>,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    let limit = pagination.limit_val();
    let offset = pagination.offset();

    let rows = sqlx::query_as::<_, (Uuid, Uuid, String, String, Option<String>, Option<Uuid>, Option<String>, chrono::DateTime<chrono::Utc>)>(
        r#"SELECT wh.id, wh.media_id, m.title, m.media_type, m.poster_path, wh.episode_id, e.name as episode_name, wh.watched_at
        FROM watch_history wh
        JOIN media m ON wh.media_id = m.id
        LEFT JOIN episodes e ON wh.episode_id = e.id
        WHERE wh.user_id = $1
        ORDER BY wh.watched_at DESC
        LIMIT $2 OFFSET $3"#
    )
    .bind(user_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool.get_ref())
    .await?;

    let response: Vec<HistoryResponse> = rows
        .into_iter()
        .map(
            |(
                id,
                media_id,
                media_title,
                media_type,
                poster_path,
                episode_id,
                episode_name,
                watched_at,
            )| {
                HistoryResponse {
                    id,
                    media_id,
                    media_title,
                    media_type,
                    poster_path,
                    episode_id,
                    episode_name,
                    watched_at,
                }
            },
        )
        .collect();

    Ok(HttpResponse::Ok().json(response))
}

async fn create_history(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    body: web::Json<CreateHistoryRequest>,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    let data = body.into_inner();

    // Validate media_id exists
    let media_exists =
        sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM media WHERE id = $1)")
            .bind(data.media_id)
            .fetch_one(pool.get_ref())
            .await?;

    if !media_exists {
        return Err(AppError::BadRequest("Media not found".to_string()));
    }

    // Validate episode_id if provided
    if let Some(ep_id) = data.episode_id {
        let ep_exists = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM episodes e JOIN seasons s ON e.season_id = s.id WHERE e.id = $1 AND s.media_id = $2)"
        )
        .bind(ep_id)
        .bind(data.media_id)
        .fetch_one(pool.get_ref())
        .await?;

        if !ep_exists {
            return Err(AppError::BadRequest(
                "Episode not found for this media".to_string(),
            ));
        }
    }

    // Clamp watched_at to now (don't allow future dates)
    let watched_at = data
        .watched_at
        .unwrap_or_else(chrono::Utc::now)
        .min(chrono::Utc::now());

    let mut tx = pool.begin().await?;
    let history_count = quota::lock_and_count_history(&mut tx, user_id).await?;
    quota::ensure_history_capacity(history_count, 1)?;

    let history = sqlx::query_as::<_, crate::models::WatchHistory>(
        r#"INSERT INTO watch_history (user_id, media_id, episode_id, watched_at)
        VALUES ($1, $2, $3, $4)
        RETURNING *"#,
    )
    .bind(user_id)
    .bind(data.media_id)
    .bind(data.episode_id)
    .bind(watched_at)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;

    Ok(HttpResponse::Created().json(history))
}

async fn list_watched_episodes(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<(i32, i32)>,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    let (tmdb_id, season_number) = path.into_inner();
    validate_episode_path(tmdb_id, season_number, None)?;

    let episode_numbers = sqlx::query_scalar::<_, i32>(
        r#"SELECT DISTINCT e.episode_number
        FROM watch_history wh
        JOIN episodes e ON e.id = wh.episode_id
        JOIN seasons s ON s.id = e.season_id
        JOIN media m ON m.id = s.media_id
        WHERE wh.user_id = $1
          AND m.tmdb_id = $2
          AND m.media_type = 'tv'
          AND s.season_number = $3
        ORDER BY e.episode_number"#,
    )
    .bind(user_id)
    .bind(tmdb_id)
    .bind(season_number)
    .fetch_all(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok().json(episode_numbers))
}

async fn show_watch_progress(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<i32>,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    let tmdb_id = path.into_inner();
    validate_episode_path(tmdb_id, 0, None)?;

    let media_id = sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM media WHERE tmdb_id = $1 AND media_type = 'tv'",
    )
    .bind(tmdb_id)
    .fetch_optional(pool.get_ref())
    .await?
    .ok_or_else(|| AppError::NotFound("TV series not found".to_string()))?;

    let progress = sqlx::query_as::<_, (i32, Option<i32>, i64, i64)>(
        r#"SELECT
            seasons.season_number,
            seasons.episode_count,
            COUNT(DISTINCT episodes.id) FILTER (
                WHERE episodes.air_date IS NULL OR episodes.air_date <= CURRENT_DATE
            )::bigint AS available_episode_count,
            COUNT(DISTINCT history.episode_id)::bigint AS watched_count
        FROM seasons
        LEFT JOIN episodes ON episodes.season_id = seasons.id
        LEFT JOIN watch_history history
          ON history.episode_id = episodes.id AND history.user_id = $2
        WHERE seasons.media_id = $1
        GROUP BY seasons.id
        ORDER BY seasons.season_number"#,
    )
    .bind(media_id)
    .bind(user_id)
    .fetch_all(pool.get_ref())
    .await?
    .into_iter()
    .map(
        |(season_number, episode_count, available_episode_count, watched_count)| {
            SeasonWatchProgress {
                season_number,
                episode_count,
                available_episode_count,
                watched_count,
            }
        },
    )
    .collect::<Vec<_>>();

    Ok(HttpResponse::Ok().json(progress))
}

async fn load_tv_media_for_watch(
    pool: &PgPool,
    tmdb: &TmdbService,
    user_id: Uuid,
    tmdb_id: i32,
) -> Result<Media, AppError> {
    let (tracking_count, already_tracked) = sqlx::query_as::<_, (i64, bool)>(
        r#"SELECT
            (SELECT COUNT(*) FROM user_media WHERE user_id = $1),
            EXISTS(
                SELECT 1
                FROM user_media tracked
                JOIN media ON media.id = tracked.media_id
                WHERE tracked.user_id = $1
                  AND media.tmdb_id = $2
                  AND media.media_type = 'tv'
            )"#,
    )
    .bind(user_id)
    .bind(tmdb_id)
    .fetch_one(pool)
    .await?;
    quota::ensure_tracking_capacity(tracking_count, if already_tracked { 0 } else { 1 })?;

    tmdb.get_or_cache_media(pool, tmdb_id, "tv").await
}

async fn ensure_tracking_for_watch(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    media_id: Uuid,
) -> Result<(), AppError> {
    let tracking_count = quota::lock_and_count_tracking(tx, user_id).await?;
    let already_tracked = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM user_media WHERE user_id = $1 AND media_id = $2)",
    )
    .bind(user_id)
    .bind(media_id)
    .fetch_one(&mut **tx)
    .await?;
    quota::ensure_tracking_capacity(tracking_count, if already_tracked { 0 } else { 1 })?;

    sqlx::query(
        r#"INSERT INTO user_media (user_id, media_id, status, started_at)
        VALUES ($1, $2, 'watching', CURRENT_DATE)
        ON CONFLICT (user_id, media_id) DO UPDATE SET
            status = CASE
                WHEN user_media.status IN ('plan_to_watch', 'on_hold', 'dropped')
                    THEN 'watching'
                ELSE user_media.status
            END,
            started_at = COALESCE(
                user_media.started_at,
                user_media.completed_at,
                CURRENT_DATE
            ),
            updated_at = NOW()"#,
    )
    .bind(user_id)
    .bind(media_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn cache_bulk_seasons(
    pool: &PgPool,
    tmdb: &TmdbService,
    media: &Media,
    target_season: i32,
    include_previous: bool,
) -> Result<(), AppError> {
    let season_numbers = if include_previous && target_season > 0 {
        sqlx::query_scalar::<_, i32>(
            r#"SELECT season_number
            FROM seasons
            WHERE media_id = $1 AND season_number BETWEEN 1 AND $2
            ORDER BY season_number"#,
        )
        .bind(media.id)
        .bind(target_season)
        .fetch_all(pool)
        .await?
    } else {
        sqlx::query_scalar::<_, i32>(
            "SELECT season_number FROM seasons WHERE media_id = $1 AND season_number = $2",
        )
        .bind(media.id)
        .bind(target_season)
        .fetch_all(pool)
        .await?
    };

    if !season_numbers.contains(&target_season) {
        return Err(AppError::NotFound("Season not found".to_string()));
    }
    if season_numbers.len() > MAX_BULK_SEASONS {
        return Err(AppError::BadRequest(format!(
            "A bulk watch can include at most {MAX_BULK_SEASONS} seasons"
        )));
    }

    let cached_seasons = stream::iter(season_numbers)
        .map(|season_number| tmdb.cache_season_episodes(pool, media, season_number))
        .buffer_unordered(BULK_SEASON_CACHE_CONCURRENCY)
        .try_collect::<Vec<_>>()
        .await?;
    let cached_episode_count = cached_seasons.iter().try_fold(0_usize, |total, episodes| {
        total
            .checked_add(episodes.len())
            .ok_or_else(|| AppError::BadRequest("Bulk episode selection is too large".to_string()))
    })?;
    if cached_episode_count > MAX_BULK_EPISODES {
        return Err(AppError::BadRequest(format!(
            "A bulk watch can include at most {MAX_BULK_EPISODES} episodes"
        )));
    }
    Ok(())
}

async fn write_bulk_episode_history(
    pool: &PgPool,
    user_id: Uuid,
    media_id: Uuid,
    episode_ids: Vec<Uuid>,
) -> Result<BulkWatchResponse, AppError> {
    if episode_ids.is_empty() {
        return Err(AppError::NotFound(
            "No available episodes were found".to_string(),
        ));
    }
    if episode_ids.len() > MAX_BULK_EPISODES {
        return Err(AppError::BadRequest(format!(
            "A bulk watch can include at most {MAX_BULK_EPISODES} episodes"
        )));
    }
    let candidate_count = i64::try_from(episode_ids.len())
        .map_err(|_| AppError::BadRequest("Bulk episode selection is too large".to_string()))?;

    let mut tx = pool.begin().await?;
    ensure_tracking_for_watch(&mut tx, user_id, media_id).await?;
    let history_count = quota::lock_and_count_history(&mut tx, user_id).await?;
    let already_watched_count = sqlx::query_scalar::<_, i64>(
        r#"SELECT COUNT(DISTINCT episode_id)
        FROM watch_history
        WHERE user_id = $1
          AND media_id = $2
          AND episode_id = ANY($3)"#,
    )
    .bind(user_id)
    .bind(media_id)
    .bind(&episode_ids)
    .fetch_one(&mut *tx)
    .await?;
    let additional = candidate_count - already_watched_count;
    quota::ensure_history_capacity(history_count, additional)?;

    let marked_count = i64::try_from(
        sqlx::query(
            r#"INSERT INTO watch_history (user_id, media_id, episode_id, watched_at)
            SELECT $1, $2, selected.episode_id, NOW()
            FROM UNNEST($3::uuid[]) AS selected(episode_id)
            WHERE NOT EXISTS (
                SELECT 1 FROM watch_history existing
                WHERE existing.user_id = $1
                  AND existing.media_id = $2
                  AND existing.episode_id = selected.episode_id
            )"#,
        )
        .bind(user_id)
        .bind(media_id)
        .bind(&episode_ids)
        .execute(&mut *tx)
        .await?
        .rows_affected(),
    )
    .map_err(|_| AppError::InternalError(anyhow::anyhow!("bulk watch count overflow")))?;
    tx.commit().await?;

    Ok(BulkWatchResponse {
        media_id,
        candidate_count,
        marked_count,
        already_watched_count: candidate_count - marked_count,
    })
}

async fn mark_season_watched(
    pool: web::Data<PgPool>,
    tmdb: web::Data<TmdbService>,
    req: HttpRequest,
    path: web::Path<(i32, i32)>,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    let (tmdb_id, season_number) = path.into_inner();
    validate_episode_path(tmdb_id, season_number, None)?;
    let media = load_tv_media_for_watch(pool.get_ref(), tmdb.get_ref(), user_id, tmdb_id).await?;
    cache_bulk_seasons(pool.get_ref(), tmdb.get_ref(), &media, season_number, false).await?;
    let episode_ids = sqlx::query_scalar::<_, Uuid>(
        r#"SELECT episodes.id
        FROM episodes
        JOIN seasons ON seasons.id = episodes.season_id
        WHERE seasons.media_id = $1
          AND seasons.season_number = $2
          AND (episodes.air_date IS NULL OR episodes.air_date <= CURRENT_DATE)
        ORDER BY episodes.episode_number"#,
    )
    .bind(media.id)
    .bind(season_number)
    .fetch_all(pool.get_ref())
    .await?;
    let response =
        write_bulk_episode_history(pool.get_ref(), user_id, media.id, episode_ids).await?;
    Ok(HttpResponse::Ok().json(response))
}

async fn mark_episodes_watched_through(
    pool: web::Data<PgPool>,
    tmdb: web::Data<TmdbService>,
    req: HttpRequest,
    path: web::Path<(i32, i32, i32)>,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    let (tmdb_id, season_number, episode_number) = path.into_inner();
    validate_episode_path(tmdb_id, season_number, Some(episode_number))?;
    let media = load_tv_media_for_watch(pool.get_ref(), tmdb.get_ref(), user_id, tmdb_id).await?;
    cache_bulk_seasons(pool.get_ref(), tmdb.get_ref(), &media, season_number, true).await?;

    let target_exists = sqlx::query_scalar::<_, bool>(
        r#"SELECT EXISTS (
            SELECT 1
            FROM episodes
            JOIN seasons ON seasons.id = episodes.season_id
            WHERE seasons.media_id = $1
              AND seasons.season_number = $2
              AND episodes.episode_number = $3
        )"#,
    )
    .bind(media.id)
    .bind(season_number)
    .bind(episode_number)
    .fetch_one(pool.get_ref())
    .await?;
    if !target_exists {
        return Err(AppError::NotFound("Episode not found".to_string()));
    }

    let episode_ids = sqlx::query_scalar::<_, Uuid>(
        r#"SELECT episodes.id
        FROM episodes
        JOIN seasons ON seasons.id = episodes.season_id
        WHERE seasons.media_id = $1
          AND (
              ($2 = 0 AND seasons.season_number = 0 AND episodes.episode_number <= $3)
              OR (
                  $2 > 0
                  AND seasons.season_number BETWEEN 1 AND $2
                  AND (
                      seasons.season_number < $2
                      OR episodes.episode_number <= $3
                  )
              )
          )
        ORDER BY seasons.season_number, episodes.episode_number"#,
    )
    .bind(media.id)
    .bind(season_number)
    .bind(episode_number)
    .fetch_all(pool.get_ref())
    .await?;
    let response =
        write_bulk_episode_history(pool.get_ref(), user_id, media.id, episode_ids).await?;
    Ok(HttpResponse::Ok().json(response))
}

async fn mark_episode_watched(
    pool: web::Data<PgPool>,
    tmdb: web::Data<TmdbService>,
    req: HttpRequest,
    path: web::Path<(i32, i32, i32)>,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    let (tmdb_id, season_number, episode_number) = path.into_inner();
    validate_episode_path(tmdb_id, season_number, Some(episode_number))?;

    let media = load_tv_media_for_watch(pool.get_ref(), tmdb.get_ref(), user_id, tmdb_id).await?;
    let episode = tmdb
        .cache_season_episodes(pool.get_ref(), &media, season_number)
        .await?
        .into_iter()
        .find(|episode| episode.episode_number == episode_number)
        .ok_or_else(|| AppError::NotFound("Episode not found".to_string()))?;

    let mut tx = pool.begin().await?;
    ensure_tracking_for_watch(&mut tx, user_id, media.id).await?;
    let history_count = quota::lock_and_count_history(&mut tx, user_id).await?;
    let existing_history_id = sqlx::query_scalar::<_, Uuid>(
        r#"SELECT id FROM watch_history
        WHERE user_id = $1 AND media_id = $2 AND episode_id = $3
        ORDER BY watched_at, id
        LIMIT 1"#,
    )
    .bind(user_id)
    .bind(media.id)
    .bind(episode.id)
    .fetch_optional(&mut *tx)
    .await?;

    if let Some(history_id) = existing_history_id {
        tx.commit().await?;
        return Ok(HttpResponse::Ok().json(serde_json::json!({
            "history_id": history_id,
            "media_id": media.id,
            "episode_id": episode.id,
            "already_watched": true,
        })));
    }

    quota::ensure_history_capacity(history_count, 1)?;
    let history_id = sqlx::query_scalar::<_, Uuid>(
        r#"INSERT INTO watch_history (user_id, media_id, episode_id, watched_at)
        VALUES ($1, $2, $3, NOW())
        RETURNING id"#,
    )
    .bind(user_id)
    .bind(media.id)
    .bind(episode.id)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;

    Ok(HttpResponse::Created().json(serde_json::json!({
        "history_id": history_id,
        "media_id": media.id,
        "episode_id": episode.id,
        "already_watched": false,
    })))
}

async fn delete_history(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<Uuid>,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    let history_id = path.into_inner();

    let mut tx = pool.begin().await?;
    quota::lock_history_writes(&mut tx, user_id).await?;
    let result = sqlx::query("DELETE FROM watch_history WHERE id = $1 AND user_id = $2")
        .bind(history_id)
        .bind(user_id)
        .execute(&mut *tx)
        .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("History entry not found".to_string()));
    }
    tx.commit().await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({"message": "Deleted"})))
}
