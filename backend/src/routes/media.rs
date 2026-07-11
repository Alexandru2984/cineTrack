use actix_web::{web, HttpRequest, HttpResponse};
use sqlx::PgPool;
use uuid::Uuid;
use validator::Validate;

use crate::dto::media::*;
use crate::errors::AppError;
use crate::middleware::auth::require_auth;
use crate::services::tmdb::TmdbService;

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::scope("/media")
            .route("/search", web::get().to(search))
            .route("/trending", web::get().to(trending))
            .route("/{id}", web::get().to(get_detail))
            .route("/{id}/seasons", web::get().to(get_seasons))
            .route(
                "/{id}/seasons/{season_number}/episodes",
                web::get().to(get_episodes),
            ),
    );
}

fn parse_tmdb_id(value: &str) -> Result<i32, AppError> {
    let id = value
        .parse::<i32>()
        .map_err(|_| AppError::BadRequest("Invalid ID".to_string()))?;
    if id <= 0 {
        return Err(AppError::BadRequest("TMDB ID must be positive".to_string()));
    }
    Ok(id)
}

fn validate_media_type(media_type: &str) -> Result<(), AppError> {
    if matches!(media_type, "movie" | "tv") {
        Ok(())
    } else {
        Err(AppError::BadRequest(
            "Media type must be movie or tv".to_string(),
        ))
    }
}

fn validate_season_number(season_number: i32) -> Result<(), AppError> {
    if (0..=500).contains(&season_number) {
        Ok(())
    } else {
        Err(AppError::BadRequest(
            "Season number must be between 0 and 500".to_string(),
        ))
    }
}

async fn search(
    tmdb: web::Data<TmdbService>,
    req: HttpRequest,
    query: web::Query<SearchQuery>,
) -> Result<HttpResponse, AppError> {
    require_auth(&req).await?;
    query.validate()?;
    let results = tmdb
        .search(&query.q, query.media_type.as_deref(), query.page)
        .await?;

    Ok(HttpResponse::Ok().json(results))
}

async fn trending(
    tmdb: web::Data<TmdbService>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    require_auth(&req).await?;
    let results = tmdb.get_trending().await?;
    Ok(HttpResponse::Ok().json(results))
}

async fn get_detail(
    pool: web::Data<PgPool>,
    tmdb: web::Data<TmdbService>,
    req: HttpRequest,
    path: web::Path<String>,
    query: web::Query<std::collections::HashMap<String, String>>,
) -> Result<HttpResponse, AppError> {
    require_auth(&req).await?;
    let id_str = path.into_inner();
    let media_type = query.get("type").map(|s| s.as_str()).unwrap_or("movie");
    validate_media_type(media_type)?;

    // Try UUID first (local media), then TMDB ID
    if let Ok(uuid) = id_str.parse::<Uuid>() {
        let media = sqlx::query_as::<_, crate::models::Media>("SELECT * FROM media WHERE id = $1")
            .bind(uuid)
            .fetch_optional(pool.get_ref())
            .await?
            .ok_or_else(|| AppError::NotFound("Media not found".to_string()))?;

        return Ok(HttpResponse::Ok().json(media));
    }

    let tmdb_id = parse_tmdb_id(&id_str)?;

    let media = tmdb
        .get_or_cache_media(pool.get_ref(), tmdb_id, media_type)
        .await?;
    Ok(HttpResponse::Ok().json(media))
}

async fn get_seasons(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    require_auth(&req).await?;
    let id_str = path.into_inner();

    let media_id = if let Ok(uuid) = id_str.parse::<Uuid>() {
        let media_type =
            sqlx::query_scalar::<_, String>("SELECT media_type FROM media WHERE id = $1")
                .bind(uuid)
                .fetch_optional(pool.get_ref())
                .await?
                .ok_or_else(|| AppError::NotFound("Media not found".to_string()))?;
        if media_type != "tv" {
            return Err(AppError::BadRequest(
                "Seasons are only available for TV series".to_string(),
            ));
        }
        uuid
    } else {
        let tmdb_id = parse_tmdb_id(&id_str)?;
        sqlx::query_scalar::<_, Uuid>(
            "SELECT id FROM media WHERE tmdb_id = $1 AND media_type = 'tv'",
        )
        .bind(tmdb_id)
        .fetch_optional(pool.get_ref())
        .await?
        .ok_or_else(|| AppError::NotFound("Media not found, fetch details first".to_string()))?
    };

    let seasons = sqlx::query_as::<_, crate::models::Season>(
        "SELECT * FROM seasons WHERE media_id = $1 ORDER BY season_number",
    )
    .bind(media_id)
    .fetch_all(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok().json(seasons))
}

async fn get_episodes(
    pool: web::Data<PgPool>,
    tmdb: web::Data<TmdbService>,
    req: HttpRequest,
    path: web::Path<(String, i32)>,
) -> Result<HttpResponse, AppError> {
    require_auth(&req).await?;
    let (id_str, season_number) = path.into_inner();
    validate_season_number(season_number)?;

    let media = if let Ok(uuid) = id_str.parse::<Uuid>() {
        sqlx::query_as::<_, crate::models::Media>("SELECT * FROM media WHERE id = $1")
            .bind(uuid)
            .fetch_optional(pool.get_ref())
            .await?
            .ok_or_else(|| AppError::NotFound("Media not found".to_string()))?
    } else {
        let tmdb_id = parse_tmdb_id(&id_str)?;
        sqlx::query_as::<_, crate::models::Media>(
            "SELECT * FROM media WHERE tmdb_id = $1 AND media_type = 'tv'",
        )
        .bind(tmdb_id)
        .fetch_optional(pool.get_ref())
        .await?
        .ok_or_else(|| AppError::NotFound("Media not found".to_string()))?
    };

    if media.media_type != "tv" {
        return Err(AppError::BadRequest(
            "Episodes are only available for TV series".to_string(),
        ));
    }

    let episodes = tmdb
        .cache_season_episodes(pool.get_ref(), &media, season_number)
        .await?;
    Ok(HttpResponse::Ok().json(episodes))
}
