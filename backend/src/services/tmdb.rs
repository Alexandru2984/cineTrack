use chrono::{NaiveDate, Utc};
use sqlx::PgPool;
use std::time::Duration;

use crate::config::Config;
use crate::dto::media::*;
use crate::errors::AppError;
use crate::models::Media;

#[derive(Clone)]
pub struct TmdbService {
    client: reqwest::Client,
    image_client: reqwest::Client,
    api_key: String,
    /// When set, the v4 Read Access Token is sent as a Bearer header and the
    /// `api_key` query param is omitted, keeping the credential out of URLs/logs.
    use_bearer_auth: bool,
    base_url: String,
}

impl TmdbService {
    pub fn new(config: &Config) -> Self {
        let image_client = reqwest::Client::builder()
            .timeout(Duration::from_secs(config.tmdb_timeout_seconds))
            .connect_timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent("cinetrack/0.1")
            .build()
            .expect("Failed to build TMDB image HTTP client");
        let mut builder = reqwest::Client::builder()
            .timeout(Duration::from_secs(config.tmdb_timeout_seconds))
            .connect_timeout(Duration::from_secs(5))
            .user_agent("cinetrack/0.1");

        // Prefer the v4 Read Access Token via an Authorization header so the
        // secret never lands in a request URL or access log. Fall back to the
        // v3 api_key query param if the token is missing or not header-safe.
        let mut use_bearer_auth = false;
        if let Some(token) = &config.tmdb_read_access_token {
            match reqwest::header::HeaderValue::from_str(&format!("Bearer {token}")) {
                Ok(mut value) => {
                    value.set_sensitive(true);
                    let mut headers = reqwest::header::HeaderMap::new();
                    headers.insert(reqwest::header::AUTHORIZATION, value);
                    builder = builder.default_headers(headers);
                    use_bearer_auth = true;
                }
                Err(e) => {
                    log::error!(
                        "TMDB_READ_ACCESS_TOKEN is not a valid header value ({e}); \
                         falling back to api_key query param"
                    );
                }
            }
        }

        let client = builder.build().expect("Failed to build TMDB HTTP client");

        Self {
            client,
            image_client,
            api_key: config.tmdb_api_key.clone(),
            use_bearer_auth,
            base_url: config.tmdb_base_url.clone(),
        }
    }

    /// Add the v3 `api_key` query param unless Bearer auth (v4 token) is in use.
    fn authed(&self, rb: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        if self.use_bearer_auth {
            rb
        } else {
            rb.query(&[("api_key", self.api_key.as_str())])
        }
    }

    /// Download a public TMDB image with the same connect/request timeouts as
    /// the API client. The body is consumed incrementally so a missing or false
    /// Content-Length header cannot make the process buffer an unbounded file.
    pub async fn fetch_image(
        &self,
        image_base_url: &str,
        spec: &str,
        max_bytes: usize,
    ) -> Result<Vec<u8>, AppError> {
        let url = format!("{}/{}", image_base_url.trim_end_matches('/'), spec);
        let mut response = self.image_client.get(url).send().await?;

        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Err(AppError::NotFound("Image not found".to_string()));
        }
        if !response.status().is_success() {
            return Err(AppError::TmdbError("Image fetch failed".to_string()));
        }
        if response
            .content_length()
            .is_some_and(|length| length > max_bytes as u64)
        {
            return Err(AppError::TmdbError("Image is too large".to_string()));
        }

        let mut bytes = Vec::with_capacity(
            response
                .content_length()
                .unwrap_or_default()
                .min(max_bytes as u64) as usize,
        );
        while let Some(chunk) = response.chunk().await? {
            if chunk.len() > max_bytes.saturating_sub(bytes.len()) {
                return Err(AppError::TmdbError("Image is too large".to_string()));
            }
            bytes.extend_from_slice(&chunk);
        }

        Ok(bytes)
    }

    pub async fn search(
        &self,
        query: &str,
        media_type: Option<&str>,
        page: Option<u32>,
    ) -> Result<TmdbSearchResponse, AppError> {
        let endpoint = match media_type {
            Some("movie") => "search/movie",
            Some("tv") => "search/tv",
            _ => "search/multi",
        };

        let page = page.unwrap_or(1).to_string();
        let resp = self
            .authed(
                self.client
                    .get(format!("{}/{}", self.base_url, endpoint))
                    .query(&[
                        ("query", query),
                        ("page", page.as_str()),
                        ("language", "en-US"),
                    ]),
            )
            .send()
            .await?
            .error_for_status()?
            .json::<TmdbSearchResponse>()
            .await?;

        Ok(resp)
    }

    pub async fn get_movie_detail(&self, tmdb_id: i32) -> Result<TmdbMovieDetail, AppError> {
        let resp = self
            .authed(
                self.client
                    .get(format!("{}/movie/{}", self.base_url, tmdb_id))
                    .query(&[("language", "en-US")]),
            )
            .send()
            .await?
            .error_for_status()?
            .json::<TmdbMovieDetail>()
            .await?;

        Ok(resp)
    }

    pub async fn get_tv_detail(&self, tmdb_id: i32) -> Result<TmdbTvDetail, AppError> {
        let resp = self
            .authed(
                self.client
                    .get(format!("{}/tv/{}", self.base_url, tmdb_id))
                    .query(&[("language", "en-US")]),
            )
            .send()
            .await?
            .error_for_status()?
            .json::<TmdbTvDetail>()
            .await?;

        Ok(resp)
    }

    pub async fn get_season_episodes(
        &self,
        tmdb_id: i32,
        season_number: i32,
    ) -> Result<TmdbSeasonDetail, AppError> {
        if tmdb_id <= 0 || !(0..=500).contains(&season_number) {
            return Err(AppError::BadRequest(
                "Invalid TMDB ID or season number".to_string(),
            ));
        }
        let resp = self
            .authed(
                self.client
                    .get(format!(
                        "{}/tv/{}/season/{}",
                        self.base_url, tmdb_id, season_number
                    ))
                    .query(&[("language", "en-US")]),
            )
            .send()
            .await?
            .error_for_status()?
            .json::<TmdbSeasonDetail>()
            .await?;

        Ok(resp)
    }

    pub async fn get_trending(&self) -> Result<TmdbTrendingResponse, AppError> {
        let resp = self
            .authed(
                self.client
                    .get(format!("{}/trending/all/week", self.base_url))
                    .query(&[("language", "en-US")]),
            )
            .send()
            .await?
            .error_for_status()?
            .json::<TmdbTrendingResponse>()
            .await?;

        Ok(resp)
    }

    /// Map an external id (TVDB/IMDB) to TMDB via `/find`. `source` is e.g.
    /// "tvdb_id" or "imdb_id". Returns matches grouped by media type.
    pub async fn find_by_external_id(
        &self,
        external_id: &str,
        source: &str,
    ) -> Result<TmdbFindResponse, AppError> {
        let resp = self
            .authed(
                self.client
                    .get(format!("{}/find/{}", self.base_url, external_id))
                    .query(&[("external_source", source), ("language", "en-US")]),
            )
            .send()
            .await?
            .error_for_status()?
            .json::<TmdbFindResponse>()
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
            "SELECT * FROM media WHERE tmdb_id = $1 AND media_type = $2",
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

    async fn upsert_movie(
        &self,
        pool: &PgPool,
        detail: &TmdbMovieDetail,
    ) -> Result<Media, AppError> {
        let release_date = detail
            .release_date
            .as_deref()
            .and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok());
        let genres_json = detail
            .genres
            .as_ref()
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
        let air_date = detail
            .first_air_date
            .as_deref()
            .and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok());
        let genres_json = detail
            .genres
            .as_ref()
            .map(|g| serde_json::to_value(g).unwrap_or_default());
        let runtime = detail
            .episode_run_time
            .as_ref()
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
                let season_air_date = s
                    .air_date
                    .as_deref()
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
                .await?;
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
            "SELECT * FROM seasons WHERE media_id = $1 AND season_number = $2",
        )
        .bind(media.id)
        .bind(season_number)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::NotFound("Season not found".to_string()))?;

        if season
            .episodes_cached_at
            .is_some_and(|cached_at| Utc::now() - cached_at < chrono::Duration::hours(24))
        {
            return sqlx::query_as::<_, crate::models::Episode>(
                "SELECT * FROM episodes WHERE season_id = $1 ORDER BY episode_number",
            )
            .bind(season.id)
            .fetch_all(pool)
            .await
            .map_err(AppError::from);
        }

        let tmdb_episodes = self
            .get_season_episodes(media.tmdb_id, season_number)
            .await?;

        let mut tx = pool.begin().await?;
        for ep in &tmdb_episodes.episodes {
            let ep_air_date = ep
                .air_date
                .as_deref()
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
            .execute(&mut *tx)
            .await?;
        }

        sqlx::query("UPDATE seasons SET episodes_cached_at = NOW() WHERE id = $1")
            .bind(season.id)
            .execute(&mut *tx)
            .await?;

        let episodes = sqlx::query_as::<_, crate::models::Episode>(
            "SELECT * FROM episodes WHERE season_id = $1 ORDER BY episode_number",
        )
        .bind(season.id)
        .fetch_all(&mut *tx)
        .await?;
        tx.commit().await?;

        Ok(episodes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::sync::oneshot;

    fn config_with_token(read_access_token: Option<&str>) -> Config {
        Config {
            app_env: "test".to_string(),
            app_host: "127.0.0.1".to_string(),
            app_port: 0,
            frontend_url: "http://localhost:5173".to_string(),
            database_url: "postgres://example".to_string(),
            jwt_secret: "test_secret_must_be_64_chars_long_so_we_pad_it_here_abcdefghijklmnopq"
                .to_string(),
            jwt_expiry_hours: 1,
            jwt_refresh_expiry_days: 30,
            tmdb_api_key: "fake_v3_key".to_string(),
            tmdb_read_access_token: read_access_token.map(str::to_string),
            tmdb_base_url: "https://api.themoviedb.org/3".to_string(),
            tmdb_image_base_url: "https://image.tmdb.org/t/p".to_string(),
            tmdb_timeout_seconds: 10,
            cors_allowed_origins: vec!["http://localhost:5173".to_string()],
            rate_limit_rps: 10,
            rate_limit_burst: 50,
            smtp_host: None,
            smtp_port: 587,
            smtp_username: None,
            smtp_password: None,
            smtp_from: "CineTrack <noreply@localhost>".to_string(),
            r2: None,
        }
    }

    async fn response_server(response: Vec<u8>) -> (String, oneshot::Receiver<String>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (request_tx, request_rx) = oneshot::channel();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut chunk = [0_u8; 1024];
            loop {
                let read = socket.read(&mut chunk).await.unwrap();
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..read]);
                if request.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
            let _ = request_tx.send(String::from_utf8_lossy(&request).into_owned());
            socket.write_all(&response).await.unwrap();
        });
        (format!("http://{address}"), request_rx)
    }

    #[test]
    fn uses_bearer_auth_when_read_access_token_present() {
        let service = TmdbService::new(&config_with_token(Some("v4-read-access-token")));
        assert!(service.use_bearer_auth);
    }

    #[test]
    fn falls_back_to_api_key_without_read_access_token() {
        let service = TmdbService::new(&config_with_token(None));
        assert!(!service.use_bearer_auth);
    }

    #[test]
    fn falls_back_to_api_key_when_token_is_not_header_safe() {
        // A control character cannot be encoded as a header value, so the client
        // must degrade to the api_key query param rather than panic.
        let service = TmdbService::new(&config_with_token(Some("bad\ntoken")));
        assert!(!service.use_bearer_auth);
    }

    #[tokio::test]
    async fn image_download_uses_an_uncredentialed_client() {
        let (base_url, request) = response_server(
            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok".to_vec(),
        )
        .await;
        let service = TmdbService::new(&config_with_token(Some("v4-read-access-token")));

        let bytes = service
            .fetch_image(&base_url, "image.jpg", 10)
            .await
            .unwrap();

        assert_eq!(bytes, b"ok");
        assert!(!request
            .await
            .unwrap()
            .to_ascii_lowercase()
            .contains("authorization:"));
    }

    #[tokio::test]
    async fn image_download_enforces_streaming_body_limit() {
        let (base_url, _) =
            response_server(b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n01234567890".to_vec())
                .await;
        let service = TmdbService::new(&config_with_token(None));

        let result = service.fetch_image(&base_url, "image.jpg", 10).await;

        assert!(matches!(result, Err(AppError::TmdbError(_))));
    }

    #[tokio::test]
    async fn image_download_rejects_oversized_content_length() {
        let (base_url, _) = response_server(
            b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\n".to_vec(),
        )
        .await;
        let service = TmdbService::new(&config_with_token(None));

        let result = service.fetch_image(&base_url, "image.jpg", 10).await;

        assert!(matches!(result, Err(AppError::TmdbError(_))));
    }
}
