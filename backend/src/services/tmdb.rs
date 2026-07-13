use chrono::{DateTime, NaiveDate, Utc};
use serde::de::DeserializeOwned;
use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, OwnedMutexGuard, OwnedSemaphorePermit, Semaphore};
use tokio::time::timeout;

use crate::config::Config;
use crate::dto::media::*;
use crate::errors::AppError;
use crate::models::Media;

const MAX_API_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_CONCURRENT_API_REQUESTS: usize = 16;
const MAX_CONCURRENT_IMAGE_REQUESTS: usize = 8;
const OUTBOUND_PERMIT_WAIT: Duration = Duration::from_secs(1);
const SEARCH_CACHE_FRESH_HOURS: i64 = 6;
const SEARCH_CACHE_STALE_DAYS: i64 = 7;
const TRENDING_CACHE_FRESH_MINUTES: i64 = 30;
const TRENDING_CACHE_STALE_HOURS: i64 = 24;

#[derive(sqlx::FromRow)]
struct ProviderCacheRow {
    payload: serde_json::Value,
    expires_at: DateTime<Utc>,
    stale_until: DateTime<Utc>,
}

struct CachedProviderResponse<T> {
    value: T,
    expires_at: DateTime<Utc>,
    stale_until: DateTime<Utc>,
}

pub(crate) fn is_valid_external_lookup_id(external_id: &str, source: &str) -> bool {
    match source {
        "tvdb_id" => external_id.parse::<u64>().is_ok_and(|value| value > 0),
        "imdb_id" => external_id.strip_prefix("tt").is_some_and(|digits| {
            (7..=12).contains(&digits.len()) && digits.bytes().all(|byte| byte.is_ascii_digit())
        }),
        _ => false,
    }
}

#[derive(Clone)]
pub struct TmdbService {
    client: reqwest::Client,
    image_client: reqwest::Client,
    api_key: String,
    /// When set, the v4 Read Access Token is sent as a Bearer header and the
    /// `api_key` query param is omitted, keeping the credential out of URLs/logs.
    use_bearer_auth: bool,
    base_url: String,
    api_requests: Arc<Semaphore>,
    image_requests: Arc<Semaphore>,
    permit_wait: Duration,
    request_locks: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
    api_cooldown_until: Arc<Mutex<Option<Instant>>>,
}

impl TmdbService {
    pub fn new(config: &Config) -> Self {
        Self::with_concurrency_limits(
            config,
            MAX_CONCURRENT_API_REQUESTS,
            MAX_CONCURRENT_IMAGE_REQUESTS,
            OUTBOUND_PERMIT_WAIT,
        )
    }

    fn with_concurrency_limits(
        config: &Config,
        max_api_requests: usize,
        max_image_requests: usize,
        permit_wait: Duration,
    ) -> Self {
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
            .redirect(reqwest::redirect::Policy::none())
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
            api_requests: Arc::new(Semaphore::new(max_api_requests)),
            image_requests: Arc::new(Semaphore::new(max_image_requests)),
            permit_wait,
            request_locks: Arc::new(Mutex::new(HashMap::new())),
            api_cooldown_until: Arc::new(Mutex::new(None)),
        }
    }

    async fn acquire_api_permit(&self) -> Result<OwnedSemaphorePermit, AppError> {
        self.acquire_permit(&self.api_requests).await
    }

    async fn acquire_image_permit(&self) -> Result<OwnedSemaphorePermit, AppError> {
        self.acquire_permit(&self.image_requests).await
    }

    async fn acquire_permit(
        &self,
        semaphore: &Arc<Semaphore>,
    ) -> Result<OwnedSemaphorePermit, AppError> {
        match timeout(self.permit_wait, semaphore.clone().acquire_owned()).await {
            Ok(Ok(permit)) => Ok(permit),
            Ok(Err(_)) | Err(_) => Err(AppError::ServiceUnavailable(
                "External media service is busy".to_string(),
            )),
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

    async fn acquire_request_lock(&self, cache_key: &str) -> OwnedMutexGuard<()> {
        let lock = {
            let mut locks = self.request_locks.lock().await;
            locks.retain(|_, lock| Arc::strong_count(lock) > 1);
            locks
                .entry(cache_key.to_string())
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        };
        lock.lock_owned().await
    }

    async fn ensure_api_not_cooling_down(&self) -> Result<(), AppError> {
        let mut cooldown = self.api_cooldown_until.lock().await;
        if cooldown.is_some_and(|until| until > Instant::now()) {
            return Err(AppError::ServiceUnavailable(
                "External media service is temporarily rate limited".to_string(),
            ));
        }
        *cooldown = None;
        Ok(())
    }

    fn response_outcome(status: reqwest::StatusCode) -> &'static str {
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            "429"
        } else if status.is_success() {
            "2xx"
        } else if status.is_client_error() {
            "4xx"
        } else if status.is_server_error() {
            "5xx"
        } else {
            "other"
        }
    }

    async fn send_api<T: DeserializeOwned>(
        &self,
        endpoint: &'static str,
        request: reqwest::RequestBuilder,
    ) -> Result<T, AppError> {
        self.ensure_api_not_cooling_down().await?;
        let _permit = self.acquire_api_permit().await?;
        let started = Instant::now();
        let response = match request.send().await {
            Ok(response) => response,
            Err(error) => {
                let outcome = if error.is_timeout() {
                    "timeout"
                } else if error.is_connect() {
                    "connect"
                } else {
                    "transport"
                };
                crate::metrics::record_tmdb_request(endpoint, outcome, started.elapsed());
                return Err(error.into());
            }
        };
        let status = response.status();

        if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            let retry_after = response
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(5)
                .clamp(1, 60);
            *self.api_cooldown_until.lock().await =
                Some(Instant::now() + Duration::from_secs(retry_after));
            crate::metrics::record_tmdb_request(endpoint, "429", started.elapsed());
            return Err(AppError::ServiceUnavailable(
                "External media service is temporarily rate limited".to_string(),
            ));
        }

        let outcome = Self::response_outcome(status);
        let result = Self::decode_api_response(response).await;
        let outcome = if result.is_err() && status.is_success() {
            "invalid"
        } else {
            outcome
        };
        crate::metrics::record_tmdb_request(endpoint, outcome, started.elapsed());
        result
    }

    fn provider_cache_key(endpoint: &str, parts: &[&str]) -> String {
        let mut digest = Sha256::new();
        digest.update(b"tmdb\0");
        digest.update(endpoint.as_bytes());
        for part in parts {
            digest.update(b"\0");
            digest.update(part.as_bytes());
        }
        hex::encode(digest.finalize())
    }

    fn normalize_search_query(query: &str) -> String {
        query
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .to_lowercase()
    }

    async fn load_provider_response<T: DeserializeOwned>(
        pool: &PgPool,
        cache_key: &str,
    ) -> Result<Option<CachedProviderResponse<T>>, sqlx::Error> {
        let row = sqlx::query_as::<_, ProviderCacheRow>(
            r#"SELECT payload, expires_at, stale_until
            FROM provider_response_cache
            WHERE provider = 'tmdb' AND cache_key = $1 AND stale_until >= NOW()"#,
        )
        .bind(cache_key)
        .fetch_optional(pool)
        .await?;

        let Some(row) = row else {
            return Ok(None);
        };
        match serde_json::from_value(row.payload) {
            Ok(value) => Ok(Some(CachedProviderResponse {
                value,
                expires_at: row.expires_at,
                stale_until: row.stale_until,
            })),
            Err(error) => {
                log::warn!("Discarding invalid TMDB provider cache entry: {error}");
                sqlx::query(
                    "DELETE FROM provider_response_cache WHERE provider = 'tmdb' AND cache_key = $1",
                )
                .bind(cache_key)
                .execute(pool)
                .await?;
                Ok(None)
            }
        }
    }

    async fn store_provider_response<T: Serialize>(
        pool: &PgPool,
        cache_key: &str,
        endpoint: &str,
        value: &T,
        fresh_for: chrono::Duration,
        stale_for: chrono::Duration,
    ) -> Result<(), AppError> {
        let payload = serde_json::to_value(value)
            .map_err(|error| AppError::InternalError(anyhow::Error::new(error)))?;
        let fetched_at = Utc::now();
        sqlx::query(
            r#"INSERT INTO provider_response_cache
                (provider, cache_key, endpoint, payload, fetched_at, expires_at, stale_until)
            VALUES ('tmdb', $1, $2, $3, $4, $5, $6)
            ON CONFLICT (provider, cache_key) DO UPDATE SET
                endpoint = EXCLUDED.endpoint,
                payload = EXCLUDED.payload,
                fetched_at = EXCLUDED.fetched_at,
                expires_at = EXCLUDED.expires_at,
                stale_until = EXCLUDED.stale_until"#,
        )
        .bind(cache_key)
        .bind(endpoint)
        .bind(payload)
        .bind(fetched_at)
        .bind(fetched_at + fresh_for)
        .bind(fetched_at + stale_for)
        .execute(pool)
        .await?;

        if let Err(error) = crate::services::media_cache::prune_provider_response_cache(pool).await
        {
            log::warn!("Provider cache cleanup after write failed: {error}");
        }
        Ok(())
    }

    async fn read_bounded_body(
        mut response: reqwest::Response,
        max_bytes: usize,
        too_large_message: &'static str,
    ) -> Result<Vec<u8>, AppError> {
        if response
            .content_length()
            .is_some_and(|length| length > max_bytes as u64)
        {
            return Err(AppError::TmdbError(too_large_message.to_string()));
        }

        let mut bytes = Vec::with_capacity(
            response
                .content_length()
                .unwrap_or_default()
                .min(max_bytes as u64) as usize,
        );
        while let Some(chunk) = response.chunk().await? {
            if chunk.len() > max_bytes.saturating_sub(bytes.len()) {
                return Err(AppError::TmdbError(too_large_message.to_string()));
            }
            bytes.extend_from_slice(&chunk);
        }

        Ok(bytes)
    }

    async fn decode_api_response<T: DeserializeOwned>(
        response: reqwest::Response,
    ) -> Result<T, AppError> {
        let response = response.error_for_status()?;
        let bytes = Self::read_bounded_body(
            response,
            MAX_API_RESPONSE_BYTES,
            "External API response is too large",
        )
        .await?;

        serde_json::from_slice(&bytes).map_err(|error| {
            log::warn!("TMDB returned invalid JSON: {error}");
            AppError::TmdbError("External API returned invalid data".to_string())
        })
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
        let _permit = self.acquire_image_permit().await?;
        let url = format!("{}/{}", image_base_url.trim_end_matches('/'), spec);
        let response = self.image_client.get(url).send().await?;

        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Err(AppError::NotFound("Image not found".to_string()));
        }
        if !response.status().is_success() {
            return Err(AppError::TmdbError("Image fetch failed".to_string()));
        }
        Self::read_bounded_body(response, max_bytes, "Image is too large").await
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
        let request = self.authed(
            self.client
                .get(format!("{}/{}", self.base_url, endpoint))
                .query(&[
                    ("query", query),
                    ("page", page.as_str()),
                    ("language", "en-US"),
                ]),
        );
        self.send_api("search", request).await
    }

    pub async fn search_cached(
        &self,
        pool: &PgPool,
        query: &str,
        media_type: Option<&str>,
        page: Option<u32>,
    ) -> Result<TmdbSearchResponse, AppError> {
        let normalized_query = Self::normalize_search_query(query);
        let media_type = media_type.unwrap_or("multi");
        let page = page.unwrap_or(1).to_string();
        let cache_key =
            Self::provider_cache_key("search", &["en-US", media_type, &page, &normalized_query]);
        let cached =
            match Self::load_provider_response::<TmdbSearchResponse>(pool, &cache_key).await {
                Ok(cached) => cached,
                Err(error) => {
                    crate::metrics::record_tmdb_cache("search", "read_error");
                    log::warn!("TMDB search cache lookup failed: {error}");
                    None
                }
            };

        if let Some(entry) = &cached {
            if entry.expires_at > Utc::now() {
                crate::metrics::record_tmdb_cache("search", "hit");
                return Ok(entry.value.clone());
            }
        }

        let _refresh_guard = self.acquire_request_lock(&cache_key).await;
        let cached =
            match Self::load_provider_response::<TmdbSearchResponse>(pool, &cache_key).await {
                Ok(cached) => cached,
                Err(error) => {
                    crate::metrics::record_tmdb_cache("search", "read_error");
                    log::warn!("TMDB search cache recheck failed: {error}");
                    cached
                }
            };
        if let Some(entry) = &cached {
            if entry.expires_at > Utc::now() {
                crate::metrics::record_tmdb_cache("search", "hit");
                return Ok(entry.value.clone());
            }
        }
        crate::metrics::record_tmdb_cache("search", "miss");

        match self
            .search(query, Some(media_type), page.parse().ok())
            .await
        {
            Ok(response) => {
                if let Err(error) = Self::store_provider_response(
                    pool,
                    &cache_key,
                    "search",
                    &response,
                    chrono::Duration::hours(SEARCH_CACHE_FRESH_HOURS),
                    chrono::Duration::days(SEARCH_CACHE_STALE_DAYS),
                )
                .await
                {
                    crate::metrics::record_tmdb_cache("search", "write_error");
                    log::warn!("TMDB search cache write failed: {error}");
                }
                Ok(response)
            }
            Err(error) => {
                if let Some(entry) = cached {
                    if entry.stale_until > Utc::now() {
                        crate::metrics::record_tmdb_cache("search", "stale");
                        log::warn!("Serving stale TMDB search response after upstream failure");
                        return Ok(entry.value);
                    }
                }
                Err(error)
            }
        }
    }

    pub async fn get_movie_detail(&self, tmdb_id: i32) -> Result<TmdbMovieDetail, AppError> {
        let request = self.authed(
            self.client
                .get(format!("{}/movie/{}", self.base_url, tmdb_id))
                .query(&[("language", "en-US")]),
        );
        self.send_api("movie_detail", request).await
    }

    pub async fn get_tv_detail(&self, tmdb_id: i32) -> Result<TmdbTvDetail, AppError> {
        let request = self.authed(
            self.client
                .get(format!("{}/tv/{}", self.base_url, tmdb_id))
                .query(&[("language", "en-US")]),
        );
        self.send_api("tv_detail", request).await
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
        let request = self.authed(
            self.client
                .get(format!(
                    "{}/tv/{}/season/{}",
                    self.base_url, tmdb_id, season_number
                ))
                .query(&[("language", "en-US")]),
        );
        self.send_api("season", request).await
    }

    pub async fn get_trending(&self) -> Result<TmdbTrendingResponse, AppError> {
        let request = self.authed(
            self.client
                .get(format!("{}/trending/all/week", self.base_url))
                .query(&[("language", "en-US")]),
        );
        self.send_api("trending", request).await
    }

    pub async fn get_trending_cached(
        &self,
        pool: &PgPool,
    ) -> Result<TmdbTrendingResponse, AppError> {
        let cache_key = Self::provider_cache_key("trending", &["all", "week", "en-US"]);
        let cached =
            match Self::load_provider_response::<TmdbTrendingResponse>(pool, &cache_key).await {
                Ok(cached) => cached,
                Err(error) => {
                    crate::metrics::record_tmdb_cache("trending", "read_error");
                    log::warn!("TMDB trending cache lookup failed: {error}");
                    None
                }
            };

        if let Some(entry) = &cached {
            if entry.expires_at > Utc::now() {
                crate::metrics::record_tmdb_cache("trending", "hit");
                return Ok(entry.value.clone());
            }
        }

        let _refresh_guard = self.acquire_request_lock(&cache_key).await;
        let cached =
            match Self::load_provider_response::<TmdbTrendingResponse>(pool, &cache_key).await {
                Ok(cached) => cached,
                Err(error) => {
                    crate::metrics::record_tmdb_cache("trending", "read_error");
                    log::warn!("TMDB trending cache recheck failed: {error}");
                    cached
                }
            };
        if let Some(entry) = &cached {
            if entry.expires_at > Utc::now() {
                crate::metrics::record_tmdb_cache("trending", "hit");
                return Ok(entry.value.clone());
            }
        }
        crate::metrics::record_tmdb_cache("trending", "miss");

        match self.get_trending().await {
            Ok(response) => {
                if let Err(error) = Self::store_provider_response(
                    pool,
                    &cache_key,
                    "trending",
                    &response,
                    chrono::Duration::minutes(TRENDING_CACHE_FRESH_MINUTES),
                    chrono::Duration::hours(TRENDING_CACHE_STALE_HOURS),
                )
                .await
                {
                    crate::metrics::record_tmdb_cache("trending", "write_error");
                    log::warn!("TMDB trending cache write failed: {error}");
                }
                Ok(response)
            }
            Err(error) => {
                if let Some(entry) = cached {
                    if entry.stale_until > Utc::now() {
                        crate::metrics::record_tmdb_cache("trending", "stale");
                        log::warn!("Serving stale TMDB trending response after upstream failure");
                        return Ok(entry.value);
                    }
                }
                Err(error)
            }
        }
    }

    /// Map an external id (TVDB/IMDB) to TMDB via `/find`. `source` is e.g.
    /// "tvdb_id" or "imdb_id". Returns matches grouped by media type.
    pub async fn find_by_external_id(
        &self,
        external_id: &str,
        source: &str,
    ) -> Result<TmdbFindResponse, AppError> {
        if !is_valid_external_lookup_id(external_id, source) {
            return Err(AppError::BadRequest(
                "Invalid external media ID".to_string(),
            ));
        }

        let mut url =
            reqwest::Url::parse(&format!("{}/find/", self.base_url.trim_end_matches('/')))
                .map_err(|_| AppError::TmdbError("External API URL is invalid".to_string()))?;
        url.path_segments_mut()
            .map_err(|_| AppError::TmdbError("External API URL is invalid".to_string()))?
            .push(external_id);

        let request = self.authed(
            self.client
                .get(url)
                .query(&[("external_source", source), ("language", "en-US")]),
        );
        self.send_api("find", request).await
    }

    async fn touch_media(pool: &PgPool, media_id: uuid::Uuid) -> Result<(), AppError> {
        sqlx::query(
            r#"UPDATE media
            SET last_accessed_at = NOW()
            WHERE id = $1 AND last_accessed_at < NOW() - INTERVAL '1 hour'"#,
        )
        .bind(media_id)
        .execute(pool)
        .await?;
        Ok(())
    }

    async fn refresh_media_unlocked(
        &self,
        pool: &PgPool,
        tmdb_id: i32,
        media_type: &str,
    ) -> Result<Media, AppError> {
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

    pub async fn refresh_media(
        &self,
        pool: &PgPool,
        tmdb_id: i32,
        media_type: &str,
    ) -> Result<Media, AppError> {
        if tmdb_id <= 0 || !matches!(media_type, "movie" | "tv") {
            return Err(AppError::BadRequest("Invalid media lookup".to_string()));
        }
        let lock_key = format!("detail:{media_type}:{tmdb_id}");
        let _refresh_guard = self.acquire_request_lock(&lock_key).await;
        self.refresh_media_unlocked(pool, tmdb_id, media_type).await
    }

    /// Fetch or refresh media from TMDB with a 24-hour freshness window. A
    /// stale local row remains usable if the provider is temporarily down.
    pub async fn get_or_cache_media(
        &self,
        pool: &PgPool,
        tmdb_id: i32,
        media_type: &str,
    ) -> Result<Media, AppError> {
        if tmdb_id <= 0 || !matches!(media_type, "movie" | "tv") {
            return Err(AppError::BadRequest("Invalid media lookup".to_string()));
        }
        let cache_name = if media_type == "movie" {
            "movie_detail"
        } else {
            "tv_detail"
        };
        let cached = sqlx::query_as::<_, Media>(
            "SELECT * FROM media WHERE tmdb_id = $1 AND media_type = $2",
        )
        .bind(tmdb_id)
        .bind(media_type)
        .fetch_optional(pool)
        .await?;

        if let Some(media) = &cached {
            let age = Utc::now() - media.tmdb_cached_at;
            if age.num_hours() < 24 {
                Self::touch_media(pool, media.id).await?;
                crate::metrics::record_tmdb_cache(cache_name, "hit");
                return Ok(media.clone());
            }
        }

        let lock_key = format!("detail:{media_type}:{tmdb_id}");
        let _refresh_guard = self.acquire_request_lock(&lock_key).await;
        let cached = sqlx::query_as::<_, Media>(
            "SELECT * FROM media WHERE tmdb_id = $1 AND media_type = $2",
        )
        .bind(tmdb_id)
        .bind(media_type)
        .fetch_optional(pool)
        .await?;
        if let Some(media) = &cached {
            let age = Utc::now() - media.tmdb_cached_at;
            if age.num_hours() < 24 {
                Self::touch_media(pool, media.id).await?;
                crate::metrics::record_tmdb_cache(cache_name, "hit");
                return Ok(media.clone());
            }
        }
        crate::metrics::record_tmdb_cache(cache_name, "miss");

        match self.refresh_media_unlocked(pool, tmdb_id, media_type).await {
            Ok(media) => Ok(media),
            Err(error) => {
                if let Some(media) = cached {
                    Self::touch_media(pool, media.id).await?;
                    crate::metrics::record_tmdb_cache(cache_name, "stale");
                    log::warn!(
                        "Serving stale {media_type} metadata for TMDB id {tmdb_id} after refresh failure"
                    );
                    return Ok(media);
                }
                Err(error)
            }
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
            r#"INSERT INTO media (tmdb_id, media_type, title, original_title, overview, poster_path, backdrop_path, release_date, status, genres, runtime_minutes, tmdb_vote_average, tmdb_cached_at, last_accessed_at)
            VALUES ($1, 'movie', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW())
            ON CONFLICT (tmdb_id, media_type)
            DO UPDATE SET title = $2, original_title = $3, overview = $4, poster_path = $5, backdrop_path = $6, release_date = $7, status = $8, genres = $9, runtime_minutes = $10, tmdb_vote_average = $11, tmdb_cached_at = NOW(), last_accessed_at = NOW()
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

        let mut tx = pool.begin().await?;
        let media = sqlx::query_as::<_, Media>(
            r#"INSERT INTO media (tmdb_id, media_type, title, original_title, overview, poster_path, backdrop_path, release_date, status, genres, runtime_minutes, tmdb_vote_average, tmdb_cached_at, last_accessed_at)
            VALUES ($1, 'tv', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW())
            ON CONFLICT (tmdb_id, media_type)
            DO UPDATE SET title = $2, original_title = $3, overview = $4, poster_path = $5, backdrop_path = $6, release_date = $7, status = $8, genres = $9, runtime_minutes = $10, tmdb_vote_average = $11, tmdb_cached_at = NOW(), last_accessed_at = NOW()
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
        .fetch_one(&mut *tx)
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
                .execute(&mut *tx)
                .await?;
            }
        }

        tx.commit().await?;
        Ok(media)
    }

    pub async fn cache_season_episodes(
        &self,
        pool: &PgPool,
        media: &Media,
        season_number: i32,
    ) -> Result<Vec<crate::models::Episode>, AppError> {
        let lock_key = format!("season:{}:{season_number}", media.tmdb_id);
        let _refresh_guard = self.acquire_request_lock(&lock_key).await;
        let season = sqlx::query_as::<_, crate::models::Season>(
            "SELECT * FROM seasons WHERE media_id = $1 AND season_number = $2",
        )
        .bind(media.id)
        .bind(season_number)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::NotFound("Season not found".to_string()))?;

        let cached_episodes = sqlx::query_as::<_, crate::models::Episode>(
            "SELECT * FROM episodes WHERE season_id = $1 ORDER BY episode_number",
        )
        .bind(season.id)
        .fetch_all(pool)
        .await?;

        if season
            .episodes_cached_at
            .is_some_and(|cached_at| Utc::now() - cached_at < chrono::Duration::hours(24))
        {
            crate::metrics::record_tmdb_cache("season_episodes", "hit");
            return Ok(cached_episodes);
        }
        crate::metrics::record_tmdb_cache("season_episodes", "miss");

        let tmdb_episodes = match self.get_season_episodes(media.tmdb_id, season_number).await {
            Ok(episodes) => episodes,
            Err(_error) if !cached_episodes.is_empty() => {
                crate::metrics::record_tmdb_cache("season_episodes", "stale");
                log::warn!(
                    "Serving stale episodes for TMDB id {} season {} after refresh failure",
                    media.tmdb_id,
                    season_number
                );
                return Ok(cached_episodes);
            }
            Err(error) => return Err(error),
        };

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

    #[test]
    fn external_lookup_ids_are_strictly_validated() {
        assert!(is_valid_external_lookup_id("123456", "tvdb_id"));
        assert!(is_valid_external_lookup_id("tt1234567", "imdb_id"));
        assert!(!is_valid_external_lookup_id("0", "tvdb_id"));
        assert!(!is_valid_external_lookup_id("-1", "tvdb_id"));
        assert!(!is_valid_external_lookup_id("../../account", "imdb_id"));
        assert!(!is_valid_external_lookup_id("tt123", "imdb_id"));
        assert!(!is_valid_external_lookup_id("tt1234567", "unknown"));
    }

    #[test]
    fn provider_cache_keys_are_normalized_and_bounded() {
        let first_query = TmdbService::normalize_search_query("  The   Matrix ");
        let second_query = TmdbService::normalize_search_query("the matrix");
        let first =
            TmdbService::provider_cache_key("search", &["en-US", "movie", "1", &first_query]);
        let second =
            TmdbService::provider_cache_key("search", &["en-US", "movie", "1", &second_query]);

        assert_eq!(first, second);
        assert_eq!(first.len(), 64);
        assert!(first.bytes().all(|byte| byte.is_ascii_hexdigit()));
    }

    #[tokio::test]
    async fn api_response_rejects_oversized_content_length() {
        let (base_url, _) = response_server(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                MAX_API_RESPONSE_BYTES + 1
            )
            .into_bytes(),
        )
        .await;
        let mut config = config_with_token(None);
        config.tmdb_base_url = base_url;
        let service = TmdbService::new(&config);

        let result = service.get_trending().await;

        assert!(matches!(result, Err(AppError::TmdbError(_))));
    }

    #[tokio::test]
    async fn rate_limit_response_starts_a_shared_cooldown() {
        let (base_url, _) = response_server(
            b"HTTP/1.1 429 Too Many Requests\r\nRetry-After: 30\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                .to_vec(),
        )
        .await;
        let mut config = config_with_token(None);
        config.tmdb_base_url = base_url;
        let service = TmdbService::new(&config);

        let first = service.get_trending().await;
        let second = service.clone().get_trending().await;

        assert!(matches!(first, Err(AppError::ServiceUnavailable(_))));
        assert!(matches!(second, Err(AppError::ServiceUnavailable(_))));
    }

    #[tokio::test]
    async fn concurrency_limits_are_shared_and_shed_waiters() {
        let service = TmdbService::with_concurrency_limits(
            &config_with_token(None),
            1,
            1,
            Duration::from_millis(20),
        );

        let api_permit = service.acquire_api_permit().await.unwrap();
        let result = service.clone().get_trending().await;
        assert!(matches!(result, Err(AppError::ServiceUnavailable(_))));
        drop(api_permit);
        assert!(service.acquire_api_permit().await.is_ok());

        let image_permit = service.acquire_image_permit().await.unwrap();
        let result = service
            .clone()
            .fetch_image("http://127.0.0.1:9", "image.jpg", 10)
            .await;
        assert!(matches!(result, Err(AppError::ServiceUnavailable(_))));
        drop(image_permit);
        assert!(service.acquire_image_permit().await.is_ok());
    }

    #[tokio::test]
    async fn api_client_does_not_follow_redirects() {
        let (redirect_target, target_request) = response_server(
            b"HTTP/1.1 200 OK\r\nContent-Length: 29\r\nConnection: close\r\n\r\n{\"results\":[],\"page\":1}\n"
                .to_vec(),
        )
        .await;
        let (base_url, _) = response_server(
            format!(
                "HTTP/1.1 302 Found\r\nLocation: {redirect_target}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            )
            .into_bytes(),
        )
        .await;
        let mut config = config_with_token(Some("v4-read-access-token"));
        config.tmdb_base_url = base_url;
        let service = TmdbService::new(&config);

        let result = service.get_trending().await;

        assert!(matches!(result, Err(AppError::TmdbError(_))));
        assert!(
            tokio::time::timeout(Duration::from_millis(100), target_request)
                .await
                .is_err()
        );
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
