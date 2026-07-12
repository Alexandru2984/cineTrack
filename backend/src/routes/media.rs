use actix_web::{web, HttpRequest, HttpResponse};
use sqlx::PgPool;
use uuid::Uuid;
use validator::Validate;

use crate::dto::media::*;
use crate::errors::AppError;
use crate::middleware::auth::require_auth;
use crate::models::{Episode, Media, Season};
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

fn parse_date(value: Option<String>) -> Option<chrono::NaiveDate> {
    value.and_then(|date| chrono::NaiveDate::parse_from_str(&date, "%Y-%m-%d").ok())
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

fn movie_detail_response(detail: TmdbMovieDetail) -> MediaResponse {
    MediaResponse {
        id: detail.id.to_string(),
        tmdb_id: detail.id,
        media_type: "movie".to_string(),
        title: detail.title,
        original_title: detail.original_title,
        overview: detail.overview,
        poster_path: detail.poster_path,
        backdrop_path: detail.backdrop_path,
        release_date: parse_date(detail.release_date),
        status: detail.status,
        genres: detail
            .genres
            .and_then(|genres| serde_json::to_value(genres).ok()),
        runtime_minutes: detail.runtime,
        vote_average: detail.vote_average,
    }
}

fn tv_detail_response(detail: TmdbTvDetail) -> MediaResponse {
    MediaResponse {
        id: detail.id.to_string(),
        tmdb_id: detail.id,
        media_type: "tv".to_string(),
        title: detail.name,
        original_title: detail.original_name,
        overview: detail.overview,
        poster_path: detail.poster_path,
        backdrop_path: detail.backdrop_path,
        release_date: parse_date(detail.first_air_date),
        status: detail.status,
        genres: detail
            .genres
            .and_then(|genres| serde_json::to_value(genres).ok()),
        runtime_minutes: detail
            .episode_run_time
            .and_then(|runtimes| runtimes.first().copied()),
        vote_average: detail.vote_average,
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

fn tmdb_season_response(season: TmdbSeason) -> SeasonResponse {
    SeasonResponse {
        id: season.id.to_string(),
        season_number: season.season_number,
        name: season.name,
        episode_count: season.episode_count,
        air_date: parse_date(season.air_date),
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

fn tmdb_episode_response(
    tmdb_id: i32,
    season_number: i32,
    episode: TmdbEpisode,
) -> EpisodeResponse {
    EpisodeResponse {
        id: format!("{tmdb_id}:{season_number}:{}", episode.episode_number),
        episode_number: episode.episode_number,
        name: episode.name,
        overview: episode.overview,
        runtime_minutes: episode.runtime,
        air_date: parse_date(episode.air_date),
        still_path: episode.still_path,
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

        return Ok(HttpResponse::Ok().json(cached_media_response(media)));
    }

    let tmdb_id = parse_tmdb_id(&id_str)?;
    let cached =
        sqlx::query_as::<_, Media>("SELECT * FROM media WHERE tmdb_id = $1 AND media_type = $2")
            .bind(tmdb_id)
            .bind(media_type)
            .fetch_optional(pool.get_ref())
            .await?;
    if let Some(media) = cached {
        if chrono::Utc::now() - media.tmdb_cached_at < chrono::Duration::hours(24) {
            return Ok(HttpResponse::Ok().json(cached_media_response(media)));
        }
    }

    let response = match media_type {
        "movie" => movie_detail_response(tmdb.get_movie_detail(tmdb_id).await?),
        "tv" => tv_detail_response(tmdb.get_tv_detail(tmdb_id).await?),
        _ => unreachable!("media type was validated"),
    };
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

    if let Ok(uuid) = id_str.parse::<Uuid>() {
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
        let seasons = sqlx::query_as::<_, Season>(
            "SELECT * FROM seasons WHERE media_id = $1 ORDER BY season_number",
        )
        .bind(uuid)
        .fetch_all(pool.get_ref())
        .await?
        .into_iter()
        .map(cached_season_response)
        .collect::<Vec<_>>();
        return Ok(HttpResponse::Ok().json(seasons));
    }

    let tmdb_id = parse_tmdb_id(&id_str)?;
    let cached_media = sqlx::query_as::<_, (Uuid, chrono::DateTime<chrono::Utc>)>(
        "SELECT id, tmdb_cached_at FROM media WHERE tmdb_id = $1 AND media_type = 'tv'",
    )
    .bind(tmdb_id)
    .fetch_optional(pool.get_ref())
    .await?;
    let cached_media_id = cached_media
        .filter(|(_, cached_at)| chrono::Utc::now() - *cached_at < chrono::Duration::hours(24))
        .map(|(media_id, _)| media_id);
    if let Some(media_id) = cached_media_id {
        let seasons = sqlx::query_as::<_, Season>(
            "SELECT * FROM seasons WHERE media_id = $1 ORDER BY season_number",
        )
        .bind(media_id)
        .fetch_all(pool.get_ref())
        .await?
        .into_iter()
        .map(cached_season_response)
        .collect::<Vec<_>>();
        return Ok(HttpResponse::Ok().json(seasons));
    }

    let seasons = tmdb
        .get_tv_detail(tmdb_id)
        .await?
        .seasons
        .unwrap_or_default()
        .into_iter()
        .map(tmdb_season_response)
        .collect::<Vec<_>>();

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

    if let Ok(uuid) = id_str.parse::<Uuid>() {
        let media = sqlx::query_as::<_, Media>("SELECT * FROM media WHERE id = $1")
            .bind(uuid)
            .fetch_optional(pool.get_ref())
            .await?
            .ok_or_else(|| AppError::NotFound("Media not found".to_string()))?;
        if media.media_type != "tv" {
            return Err(AppError::BadRequest(
                "Episodes are only available for TV series".to_string(),
            ));
        }

        let episodes = tmdb
            .cache_season_episodes(pool.get_ref(), &media, season_number)
            .await?
            .into_iter()
            .map(cached_episode_response)
            .collect::<Vec<_>>();
        return Ok(HttpResponse::Ok().json(episodes));
    }

    let tmdb_id = parse_tmdb_id(&id_str)?;
    let episodes = tmdb.get_season_episodes(tmdb_id, season_number).await?;
    let episodes = episodes
        .episodes
        .into_iter()
        .map(|episode| tmdb_episode_response(tmdb_id, season_number, episode))
        .collect::<Vec<_>>();
    Ok(HttpResponse::Ok().json(episodes))
}
