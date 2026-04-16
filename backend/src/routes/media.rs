use actix_web::{web, HttpResponse};
use sqlx::PgPool;
use uuid::Uuid;

use crate::dto::media::*;
use crate::errors::AppError;
use crate::services::tmdb::TmdbService;

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::scope("/media")
            .route("/search", web::get().to(search))
            .route("/trending", web::get().to(trending))
            .route("/{id}", web::get().to(get_detail))
            .route("/{id}/seasons", web::get().to(get_seasons))
            .route("/{id}/seasons/{season_number}/episodes", web::get().to(get_episodes))
    );
}

async fn search(
    tmdb: web::Data<TmdbService>,
    query: web::Query<SearchQuery>,
) -> Result<HttpResponse, AppError> {
    let results = tmdb
        .search(&query.q, query.media_type.as_deref(), query.page)
        .await?;

    Ok(HttpResponse::Ok().json(results))
}

async fn trending(
    tmdb: web::Data<TmdbService>,
) -> Result<HttpResponse, AppError> {
    let results = tmdb.get_trending().await?;
    Ok(HttpResponse::Ok().json(results))
}

async fn get_detail(
    pool: web::Data<PgPool>,
    tmdb: web::Data<TmdbService>,
    path: web::Path<String>,
    query: web::Query<std::collections::HashMap<String, String>>,
) -> Result<HttpResponse, AppError> {
    let id_str = path.into_inner();
    let media_type = query.get("type").map(|s| s.as_str()).unwrap_or("movie");

    // Try UUID first (local media), then TMDB ID
    if let Ok(uuid) = id_str.parse::<Uuid>() {
        let media = sqlx::query_as::<_, crate::models::Media>(
            "SELECT * FROM media WHERE id = $1"
        )
        .bind(uuid)
        .fetch_optional(pool.get_ref())
        .await?
        .ok_or_else(|| AppError::NotFound("Media not found".to_string()))?;

        return Ok(HttpResponse::Ok().json(media));
    }

    let tmdb_id: i32 = id_str.parse()
        .map_err(|_| AppError::BadRequest("Invalid ID".to_string()))?;

    let media = tmdb.get_or_cache_media(pool.get_ref(), tmdb_id, media_type).await?;
    Ok(HttpResponse::Ok().json(media))
}

async fn get_seasons(
    pool: web::Data<PgPool>,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let id_str = path.into_inner();

    let media_id = if let Ok(uuid) = id_str.parse::<Uuid>() {
        uuid
    } else {
        let tmdb_id: i32 = id_str.parse()
            .map_err(|_| AppError::BadRequest("Invalid ID".to_string()))?;
        sqlx::query_scalar::<_, Uuid>(
            "SELECT id FROM media WHERE tmdb_id = $1 AND media_type = 'tv'"
        )
        .bind(tmdb_id)
        .fetch_optional(pool.get_ref())
        .await?
        .ok_or_else(|| AppError::NotFound("Media not found, fetch details first".to_string()))?
    };

    let seasons = sqlx::query_as::<_, crate::models::Season>(
        "SELECT * FROM seasons WHERE media_id = $1 ORDER BY season_number"
    )
    .bind(media_id)
    .fetch_all(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok().json(seasons))
}

async fn get_episodes(
    pool: web::Data<PgPool>,
    tmdb: web::Data<TmdbService>,
    path: web::Path<(String, i32)>,
) -> Result<HttpResponse, AppError> {
    let (id_str, season_number) = path.into_inner();

    let media = if let Ok(uuid) = id_str.parse::<Uuid>() {
        sqlx::query_as::<_, crate::models::Media>(
            "SELECT * FROM media WHERE id = $1"
        )
        .bind(uuid)
        .fetch_optional(pool.get_ref())
        .await?
        .ok_or_else(|| AppError::NotFound("Media not found".to_string()))?
    } else {
        let tmdb_id: i32 = id_str.parse()
            .map_err(|_| AppError::BadRequest("Invalid ID".to_string()))?;
        sqlx::query_as::<_, crate::models::Media>(
            "SELECT * FROM media WHERE tmdb_id = $1 AND media_type = 'tv'"
        )
        .bind(tmdb_id)
        .fetch_optional(pool.get_ref())
        .await?
        .ok_or_else(|| AppError::NotFound("Media not found".to_string()))?
    };

    let episodes = tmdb.cache_season_episodes(pool.get_ref(), &media, season_number).await?;
    Ok(HttpResponse::Ok().json(episodes))
}
