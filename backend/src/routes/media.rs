use actix_web::{web, HttpRequest, HttpResponse};
use sqlx::PgPool;
use uuid::Uuid;
use validator::Validate;

use crate::dto::media::*;
use crate::errors::AppError;
use crate::middleware::auth::require_auth;
use crate::models::{Episode, Media, Season};
use crate::services::catalog;
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

fn validate_season_number(season_number: i32) -> Result<(), AppError> {
    if (0..=500).contains(&season_number) {
        Ok(())
    } else {
        Err(AppError::BadRequest(
            "Season number must be between 0 and 500".to_string(),
        ))
    }
}

fn cached_media_response(media: Media) -> MediaResponse {
    MediaResponse {
        id: media.id.to_string(),
        tmdb_id: media.tmdb_id,
        media_type: media.media_type,
        title: media.title,
        original_title: media.original_title,
        overview: media.overview,
        poster_path: media.poster_path,
        backdrop_path: media.backdrop_path,
        release_date: media.release_date,
        status: media.status,
        genres: media.genres,
        runtime_minutes: media.runtime_minutes,
        vote_average: media.tmdb_vote_average,
    }
}

fn cached_season_response(season: Season) -> SeasonResponse {
    SeasonResponse {
        id: season.id.to_string(),
        season_number: season.season_number,
        name: season.name,
        episode_count: season.episode_count,
        air_date: season.air_date,
    }
}

fn cached_episode_response(episode: Episode) -> EpisodeResponse {
    EpisodeResponse {
        id: episode.id.to_string(),
        episode_number: episode.episode_number,
        name: episode.name,
        overview: episode.overview,
        runtime_minutes: episode.runtime_minutes,
        air_date: episode.air_date,
        still_path: episode.still_path,
    }
}

async fn search(
    pool: web::Data<PgPool>,
    tmdb: web::Data<TmdbService>,
    req: HttpRequest,
    query: web::Query<SearchQuery>,
) -> Result<HttpResponse, AppError> {
    require_auth(&req).await?;
    query.validate()?;
    let page = query.page.unwrap_or(1);
    let local = match catalog::search_local(
        pool.get_ref(),
        &query.q,
        query.media_type.as_deref(),
        page,
        query.language.as_deref(),
    )
    .await
    {
        Ok(response) => Some(response),
        Err(error) => {
            log::warn!("Local catalog search failed: {error}");
            None
        }
    };
    if let Some(response) = local
        .as_ref()
        .filter(|response| catalog::has_local_results(response))
    {
        crate::metrics::record_tmdb_cache("local_search", "hit");
        return Ok(HttpResponse::Ok().json(response));
    }

    let provider = tmdb
        .search_cached(
            pool.get_ref(),
            &query.q,
            query.media_type.as_deref(),
            Some(page),
            query.language.as_deref(),
        )
        .await;
    let results = match provider {
        Ok(results) => {
            let cache_english_summaries = query.language.as_deref().is_none_or(|language| {
                language.eq_ignore_ascii_case("en") || language.eq_ignore_ascii_case("en-US")
            });
            if cache_english_summaries {
                if let Err(error) = catalog::cache_search_results(
                    pool.get_ref(),
                    &results,
                    query.media_type.as_deref(),
                )
                .await
                {
                    log::warn!("Could not cache TMDB search summaries: {error}");
                }
            }
            results
        }
        Err(error) => {
            if let Some(response) = local.filter(|response| !response.results.is_empty()) {
                crate::metrics::record_tmdb_cache("local_search", "fallback");
                log::warn!("Serving local catalog results after TMDB search failure");
                response
            } else {
                return Err(error);
            }
        }
    };

    Ok(HttpResponse::Ok().json(results))
}

async fn trending(
    pool: web::Data<PgPool>,
    tmdb: web::Data<TmdbService>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    require_auth(&req).await?;
    let results = tmdb.get_trending_cached(pool.get_ref()).await?;
    Ok(HttpResponse::Ok().json(results))
}

async fn get_detail(
    pool: web::Data<PgPool>,
    tmdb: web::Data<TmdbService>,
    req: HttpRequest,
    path: web::Path<String>,
    query: web::Query<MediaDetailQuery>,
) -> Result<HttpResponse, AppError> {
    require_auth(&req).await?;
    query.validate()?;
    let id_str = path.into_inner();
    let media_type = query.media_type.as_deref().unwrap_or("movie");
    let language = query.language.as_deref();

    // Try UUID first (local media), then TMDB ID.
    if let Ok(uuid) = id_str.parse::<Uuid>() {
        let media = sqlx::query_as::<_, crate::models::Media>("SELECT * FROM media WHERE id = $1")
            .bind(uuid)
            .fetch_optional(pool.get_ref())
            .await?
            .ok_or_else(|| AppError::NotFound("Media not found".to_string()))?;
        let media = tmdb
            .get_or_cache_media(pool.get_ref(), media.tmdb_id, &media.media_type)
            .await?;
        let localized_title = catalog::localized_title(pool.get_ref(), media.id, language).await?;
        let mut response = cached_media_response(media);
        if let Some(title) = localized_title {
            response.title = title;
        }
        return Ok(HttpResponse::Ok().json(response));
    }

    let tmdb_id = parse_tmdb_id(&id_str)?;
    let media = tmdb
        .get_or_cache_media(pool.get_ref(), tmdb_id, media_type)
        .await?;
    let localized_title = catalog::localized_title(pool.get_ref(), media.id, language).await?;
    let mut response = cached_media_response(media);
    if let Some(title) = localized_title {
        response.title = title;
    }
    // Keep the existing response contract for numeric detail URLs.
    response.id = tmdb_id.to_string();
    Ok(HttpResponse::Ok().json(response))
}

async fn get_seasons(
    pool: web::Data<PgPool>,
    tmdb: web::Data<TmdbService>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    require_auth(&req).await?;
    let id_str = path.into_inner();

    let media = if let Ok(uuid) = id_str.parse::<Uuid>() {
        sqlx::query_as::<_, Media>("SELECT * FROM media WHERE id = $1")
            .bind(uuid)
            .fetch_optional(pool.get_ref())
            .await?
            .ok_or_else(|| AppError::NotFound("Media not found".to_string()))?
    } else {
        let tmdb_id = parse_tmdb_id(&id_str)?;
        tmdb.get_or_cache_media(pool.get_ref(), tmdb_id, "tv")
            .await?
    };
    if media.media_type != "tv" {
        return Err(AppError::BadRequest(
            "Seasons are only available for TV series".to_string(),
        ));
    }
    let media = tmdb
        .get_or_cache_media(pool.get_ref(), media.tmdb_id, "tv")
        .await?;
    let seasons = sqlx::query_as::<_, Season>(
        "SELECT * FROM seasons WHERE media_id = $1 ORDER BY season_number",
    )
    .bind(media.id)
    .fetch_all(pool.get_ref())
    .await?
    .into_iter()
    .map(cached_season_response)
    .collect::<Vec<_>>();

    Ok(HttpResponse::Ok().json(seasons))
}

async fn cached_episodes_for_media(
    pool: &PgPool,
    tmdb: &TmdbService,
    media: Media,
    season_number: i32,
) -> Result<Vec<EpisodeResponse>, AppError> {
    let episodes = match tmdb
        .cache_season_episodes(pool, &media, season_number)
        .await
    {
        Ok(episodes) => episodes,
        Err(AppError::NotFound(_)) => {
            let refreshed = tmdb.refresh_media(pool, media.tmdb_id, "tv").await?;
            tmdb.cache_season_episodes(pool, &refreshed, season_number)
                .await?
        }
        Err(error) => return Err(error),
    };
    Ok(episodes.into_iter().map(cached_episode_response).collect())
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
        sqlx::query_as::<_, Media>("SELECT * FROM media WHERE id = $1")
            .bind(uuid)
            .fetch_optional(pool.get_ref())
            .await?
            .ok_or_else(|| AppError::NotFound("Media not found".to_string()))?
    } else {
        let tmdb_id = parse_tmdb_id(&id_str)?;
        tmdb.get_or_cache_media(pool.get_ref(), tmdb_id, "tv")
            .await?
    };
    if media.media_type != "tv" {
        return Err(AppError::BadRequest(
            "Episodes are only available for TV series".to_string(),
        ));
    }
    let media = tmdb
        .get_or_cache_media(pool.get_ref(), media.tmdb_id, "tv")
        .await?;
    let episodes =
        cached_episodes_for_media(pool.get_ref(), tmdb.get_ref(), media, season_number).await?;
    Ok(HttpResponse::Ok().json(episodes))
}
