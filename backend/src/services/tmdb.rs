use chrono::{NaiveDate, Utc};
use sqlx::PgPool;

use crate::config::Config;
use crate::dto::media::*;
use crate::errors::AppError;
use crate::models::Media;

#[derive(Clone)]
pub struct TmdbService {
    client: reqwest::Client,
    api_key: String,
    base_url: String,
}

impl TmdbService {
    pub fn new(config: &Config) -> Self {
        Self {
            client: reqwest::Client::new(),
            api_key: config.tmdb_api_key.clone(),
            base_url: config.tmdb_base_url.clone(),
        }
    }

    pub async fn search(&self, query: &str, media_type: Option<&str>, page: Option<u32>) -> Result<TmdbSearchResponse, AppError> {
        let endpoint = match media_type {
            Some("movie") => "search/movie",
            Some("tv") => "search/tv",
            _ => "search/multi",
        };

        let resp = self
            .client
            .get(format!("{}/{}", self.base_url, endpoint))
            .query(&[
                ("api_key", self.api_key.as_str()),
                ("query", query),
                ("page", &page.unwrap_or(1).to_string()),
                ("language", "en-US"),
            ])
            .send()
            .await?
            .json::<TmdbSearchResponse>()
            .await?;

        Ok(resp)
    }

    pub async fn get_movie_detail(&self, tmdb_id: i32) -> Result<TmdbMovieDetail, AppError> {
        let resp = self
            .client
            .get(format!("{}/movie/{}", self.base_url, tmdb_id))
            .query(&[("api_key", &self.api_key), ("language", &"en-US".to_string())])
            .send()
            .await?
            .json::<TmdbMovieDetail>()
            .await?;

        Ok(resp)
    }

    pub async fn get_tv_detail(&self, tmdb_id: i32) -> Result<TmdbTvDetail, AppError> {
        let resp = self
            .client
            .get(format!("{}/tv/{}", self.base_url, tmdb_id))
            .query(&[("api_key", &self.api_key), ("language", &"en-US".to_string())])
            .send()
            .await?
            .json::<TmdbTvDetail>()
            .await?;

        Ok(resp)
    }

    pub async fn get_season_episodes(&self, tmdb_id: i32, season_number: i32) -> Result<TmdbSeasonDetail, AppError> {
        let resp = self
            .client
            .get(format!("{}/tv/{}/season/{}", self.base_url, tmdb_id, season_number))
            .query(&[("api_key", &self.api_key), ("language", &"en-US".to_string())])
            .send()
            .await?
            .json::<TmdbSeasonDetail>()
            .await?;

        Ok(resp)
    }

    pub async fn get_trending(&self) -> Result<TmdbTrendingResponse, AppError> {
        let resp = self
            .client
            .get(format!("{}/trending/all/week", self.base_url))
            .query(&[("api_key", &self.api_key), ("language", &"en-US".to_string())])
            .send()
            .await?
            .json::<TmdbTrendingResponse>()
            .await?;

        Ok(resp)
    }

    /// Fetch or refresh media from TMDB with 24h cache
    pub async fn get_or_cache_media(
        &self,
        pool: &PgPool,
        tmdb_id: i32,
        media_type: &str,
    ) -> Result<Media, AppError> {
        // Check cache first
        let cached = sqlx::query_as::<_, Media>(
            "SELECT * FROM media WHERE tmdb_id = $1 AND media_type = $2"
        )
        .bind(tmdb_id)
        .bind(media_type)
        .fetch_optional(pool)
        .await?;

        if let Some(media) = cached {
            let age = Utc::now() - media.tmdb_cached_at;
            if age.num_hours() < 24 {
                return Ok(media);
            }
        }

        // Fetch from TMDB and upsert
        match media_type {
            "movie" => {
                let detail = self.get_movie_detail(tmdb_id).await?;
                self.upsert_movie(pool, &detail).await
            }
            "tv" => {
                let detail = self.get_tv_detail(tmdb_id).await?;
                self.upsert_tv(pool, &detail).await
            }
            _ => Err(AppError::BadRequest("Invalid media type".to_string())),
        }
    }

    async fn upsert_movie(&self, pool: &PgPool, detail: &TmdbMovieDetail) -> Result<Media, AppError> {
        let release_date = detail.release_date.as_deref()
            .and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok());
        let genres_json = detail.genres.as_ref()
            .map(|g| serde_json::to_value(g).unwrap_or_default());

        let media = sqlx::query_as::<_, Media>(
            r#"INSERT INTO media (tmdb_id, media_type, title, original_title, overview, poster_path, backdrop_path, release_date, status, genres, runtime_minutes, tmdb_vote_average, tmdb_cached_at)
            VALUES ($1, 'movie', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
            ON CONFLICT (tmdb_id, media_type)
            DO UPDATE SET title = $2, original_title = $3, overview = $4, poster_path = $5, backdrop_path = $6, release_date = $7, status = $8, genres = $9, runtime_minutes = $10, tmdb_vote_average = $11, tmdb_cached_at = NOW()
            RETURNING *"#
        )
        .bind(detail.id)
        .bind(&detail.title)
        .bind(&detail.original_title)
        .bind(&detail.overview)
        .bind(&detail.poster_path)
        .bind(&detail.backdrop_path)
        .bind(release_date)
        .bind(&detail.status)
        .bind(&genres_json)
        .bind(detail.runtime)
        .bind(detail.vote_average)
        .fetch_one(pool)
        .await?;

        Ok(media)
    }

    async fn upsert_tv(&self, pool: &PgPool, detail: &TmdbTvDetail) -> Result<Media, AppError> {
        let air_date = detail.first_air_date.as_deref()
            .and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok());
        let genres_json = detail.genres.as_ref()
            .map(|g| serde_json::to_value(g).unwrap_or_default());
        let runtime = detail.episode_run_time.as_ref()
            .and_then(|r| r.first().copied());

        let media = sqlx::query_as::<_, Media>(
            r#"INSERT INTO media (tmdb_id, media_type, title, original_title, overview, poster_path, backdrop_path, release_date, status, genres, runtime_minutes, tmdb_vote_average, tmdb_cached_at)
            VALUES ($1, 'tv', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
            ON CONFLICT (tmdb_id, media_type)
            DO UPDATE SET title = $2, original_title = $3, overview = $4, poster_path = $5, backdrop_path = $6, release_date = $7, status = $8, genres = $9, runtime_minutes = $10, tmdb_vote_average = $11, tmdb_cached_at = NOW()
            RETURNING *"#
        )
        .bind(detail.id)
        .bind(&detail.name)
        .bind(&detail.original_name)
        .bind(&detail.overview)
        .bind(&detail.poster_path)
        .bind(&detail.backdrop_path)
        .bind(air_date)
        .bind(&detail.status)
        .bind(&genres_json)
        .bind(runtime)
        .bind(detail.vote_average)
        .fetch_one(pool)
        .await?;

        // Also cache seasons
        if let Some(seasons) = &detail.seasons {
            for s in seasons {
                let season_air_date = s.air_date.as_deref()
                    .and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok());
                let _ = sqlx::query(
                    r#"INSERT INTO seasons (media_id, season_number, name, episode_count, air_date)
                    VALUES ($1, $2, $3, $4, $5)
                    ON CONFLICT (media_id, season_number) DO UPDATE SET name = $3, episode_count = $4, air_date = $5"#
                )
                .bind(media.id)
                .bind(s.season_number)
                .bind(&s.name)
                .bind(s.episode_count)
                .bind(season_air_date)
                .execute(pool)
                .await;
            }
        }

        Ok(media)
    }

    pub async fn cache_season_episodes(
        &self,
        pool: &PgPool,
        media: &Media,
        season_number: i32,
    ) -> Result<Vec<crate::models::Episode>, AppError> {
        let season = sqlx::query_as::<_, crate::models::Season>(
            "SELECT * FROM seasons WHERE media_id = $1 AND season_number = $2"
        )
        .bind(media.id)
        .bind(season_number)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::NotFound("Season not found".to_string()))?;

        let tmdb_episodes = self.get_season_episodes(media.tmdb_id, season_number).await?;

        for ep in &tmdb_episodes.episodes {
            let ep_air_date = ep.air_date.as_deref()
                .and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok());
            let _ = sqlx::query(
                r#"INSERT INTO episodes (season_id, episode_number, name, overview, runtime_minutes, air_date, still_path)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                ON CONFLICT (season_id, episode_number)
                DO UPDATE SET name = $3, overview = $4, runtime_minutes = $5, air_date = $6, still_path = $7"#
            )
            .bind(season.id)
            .bind(ep.episode_number)
            .bind(&ep.name)
            .bind(&ep.overview)
            .bind(ep.runtime)
            .bind(ep_air_date)
            .bind(&ep.still_path)
            .execute(pool)
            .await;
        }

        let episodes = sqlx::query_as::<_, crate::models::Episode>(
            "SELECT * FROM episodes WHERE season_id = $1 ORDER BY episode_number"
        )
        .bind(season.id)
        .fetch_all(pool)
        .await?;

        Ok(episodes)
    }
}
