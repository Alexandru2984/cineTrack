use actix_web::{web, HttpRequest, HttpResponse};
use sqlx::PgPool;
use uuid::Uuid;

use crate::dto::common::PaginationParams;
use crate::dto::tracking::*;
use crate::errors::AppError;
use crate::middleware::auth::require_auth;
use crate::services::quota;
use crate::services::tmdb::TmdbService;

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::scope("/history")
            .route("", web::get().to(list_history))
            .route("", web::post().to(create_history))
            .route(
                "/tv/{tmdb_id}/seasons/{season_number}/episodes",
                web::get().to(list_watched_episodes),
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

async fn mark_episode_watched(
    pool: web::Data<PgPool>,
    tmdb: web::Data<TmdbService>,
    req: HttpRequest,
    path: web::Path<(i32, i32, i32)>,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    let (tmdb_id, season_number, episode_number) = path.into_inner();
    validate_episode_path(tmdb_id, season_number, Some(episode_number))?;

    // Avoid an upstream lookup for an account that cannot fit a new title.
    // The transaction below repeats this check under the quota lock.
    let (tracking_count, already_tracked) = sqlx::query_as::<_, (i64, bool)>(
        r#"SELECT
            (SELECT COUNT(*) FROM user_media WHERE user_id = $1),
            EXISTS(
                SELECT 1
                FROM user_media um
                JOIN media m ON m.id = um.media_id
                WHERE um.user_id = $1 AND m.tmdb_id = $2 AND m.media_type = 'tv'
            )"#,
    )
    .bind(user_id)
    .bind(tmdb_id)
    .fetch_one(pool.get_ref())
    .await?;
    quota::ensure_tracking_capacity(tracking_count, if already_tracked { 0 } else { 1 })?;

    let media = tmdb
        .get_or_cache_media(pool.get_ref(), tmdb_id, "tv")
        .await?;
    let episode = tmdb
        .cache_season_episodes(pool.get_ref(), &media, season_number)
        .await?
        .into_iter()
        .find(|episode| episode.episode_number == episode_number)
        .ok_or_else(|| AppError::NotFound("Episode not found".to_string()))?;

    let mut tx = pool.begin().await?;
    let tracking_count = quota::lock_and_count_tracking(&mut tx, user_id).await?;
    let already_tracked = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM user_media WHERE user_id = $1 AND media_id = $2)",
    )
    .bind(user_id)
    .bind(media.id)
    .fetch_one(&mut *tx)
    .await?;
    quota::ensure_tracking_capacity(tracking_count, if already_tracked { 0 } else { 1 })?;

    sqlx::query(
        r#"INSERT INTO user_media (user_id, media_id, status, started_at)
        VALUES ($1, $2, 'watching', CURRENT_DATE)
        ON CONFLICT (user_id, media_id) DO NOTHING"#,
    )
    .bind(user_id)
    .bind(media.id)
    .execute(&mut *tx)
    .await?;

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
