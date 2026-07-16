use chrono::{DateTime, NaiveDate, Utc};
use serde::de::DeserializeOwned;
use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, QueryBuilder, Transaction};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, OwnedMutexGuard, OwnedSemaphorePermit, Semaphore};
use tokio::time::timeout;

use crate::config::Config;
use crate::dto::media::*;
use crate::errors::AppError;
use crate::models::Media;

const MAX_API_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_SEASON_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const MAX_CONCURRENT_API_REQUESTS: usize = 16;
const MAX_CONCURRENT_IMAGE_REQUESTS: usize = 8;
const OUTBOUND_PERMIT_WAIT: Duration = Duration::from_secs(1);
const SEARCH_CACHE_FRESH_HOURS: i64 = 24;
const SEARCH_CACHE_STALE_DAYS: i64 = 30;
const MAX_TITLE_ALIASES_PER_MEDIA: usize = 500;
const MAX_RELEASE_DATES_PER_MOVIE: usize = 2_000;

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

struct TitleAlias {
    kind: &'static str,
    language_code: String,
    region_code: String,
    title: String,
}

struct RegionalReleaseDate {
    country_code: String,
    release_type: i16,
    release_date: NaiveDate,
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
        self.send_api_with_limit(endpoint, request, MAX_API_RESPONSE_BYTES)
            .await
    }

    async fn send_api_with_limit<T: DeserializeOwned>(
        &self,
        endpoint: &'static str,
        request: reqwest::RequestBuilder,
        max_response_bytes: usize,
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

        if status == reqwest::StatusCode::NOT_FOUND {
            crate::metrics::record_tmdb_request(endpoint, "4xx", started.elapsed());
            return Err(AppError::NotFound(
                "External media was not found".to_string(),
            ));
        }

        let outcome = Self::response_outcome(status);
        let result = Self::decode_api_response(response, max_response_bytes).await;
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

    fn canonical_language(language: Option<&str>) -> String {
        let Some(value) = language else {
            return "en-US".to_string();
        };
        let bytes = value.as_bytes();
        if bytes.len() == 2 && bytes.iter().all(u8::is_ascii_alphabetic) {
            return value.to_ascii_lowercase();
        }
        if bytes.len() == 5
            && bytes[2] == b'-'
            && bytes[..2].iter().all(u8::is_ascii_alphabetic)
            && bytes[3..].iter().all(u8::is_ascii_alphabetic)
        {
            return format!(
                "{}-{}",
                value[..2].to_ascii_lowercase(),
                value[3..].to_ascii_uppercase()
            );
        }
        "en-US".to_string()
    }

    fn normalize_alias_title(value: &str) -> Option<String> {
        let sanitized = value
            .chars()
            .map(|character| {
                if character.is_control() {
                    ' '
                } else {
                    character
                }
            })
            .collect::<String>();
        let title = sanitized.split_whitespace().collect::<Vec<_>>().join(" ");
        (!title.is_empty() && title.chars().count() <= 500).then_some(title)
    }

    fn normalize_language_code(value: &str) -> String {
        let value = value.trim();
        if value.len() == 2 && value.bytes().all(|byte| byte.is_ascii_alphabetic()) {
            value.to_ascii_lowercase()
        } else {
            String::new()
        }
    }

    fn normalize_region_code(value: &str) -> String {
        let value = value.trim();
        if value.len() == 2 && value.bytes().all(|byte| byte.is_ascii_alphabetic()) {
            value.to_ascii_uppercase()
        } else {
            String::new()
        }
    }

    fn collect_title_aliases(
        media_type: &str,
        alternative_titles: &TmdbAlternativeTitles,
        translations: &TmdbTranslations,
    ) -> Vec<TitleAlias> {
        fn push_alias(
            aliases: &mut Vec<TitleAlias>,
            seen: &mut HashSet<(String, String, String, String)>,
            kind: &'static str,
            language_code: String,
            region_code: String,
            value: &str,
        ) {
            if aliases.len() >= MAX_TITLE_ALIASES_PER_MEDIA {
                return;
            }
            let Some(title) = TmdbService::normalize_alias_title(value) else {
                return;
            };
            let key = (
                kind.to_string(),
                language_code.clone(),
                region_code.clone(),
                title.clone(),
            );
            if seen.insert(key) {
                aliases.push(TitleAlias {
                    kind,
                    language_code,
                    region_code,
                    title,
                });
            }
        }

        let mut aliases = Vec::new();
        let mut seen = HashSet::new();
        for translation in &translations.translations {
            let title = if media_type == "movie" {
                translation
                    .data
                    .title
                    .as_deref()
                    .or(translation.data.name.as_deref())
            } else {
                translation
                    .data
                    .name
                    .as_deref()
                    .or(translation.data.title.as_deref())
            };
            if let Some(title) = title {
                push_alias(
                    &mut aliases,
                    &mut seen,
                    "translation",
                    Self::normalize_language_code(&translation.iso_639_1),
                    Self::normalize_region_code(&translation.iso_3166_1),
                    title,
                );
            }
        }
        for alternative in alternative_titles
            .titles
            .iter()
            .chain(&alternative_titles.results)
        {
            push_alias(
                &mut aliases,
                &mut seen,
                "alternative",
                String::new(),
                Self::normalize_region_code(&alternative.iso_3166_1),
                &alternative.title,
            );
        }
        aliases
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
        max_bytes: usize,
    ) -> Result<T, AppError> {
        let response = response.error_for_status()?;
        let bytes =
            Self::read_bounded_body(response, max_bytes, "External API response is too large")
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
        language: Option<&str>,
    ) -> Result<TmdbSearchResponse, AppError> {
        let endpoint = match media_type {
            Some("movie") => "search/movie",
            Some("tv") => "search/tv",
            _ => "search/multi",
        };

        let page = page.unwrap_or(1).to_string();
        let language = Self::canonical_language(language);
        let request = self.authed(
            self.client
                .get(format!("{}/{}", self.base_url, endpoint))
                .query(&[
                    ("query", query),
                    ("page", page.as_str()),
                    ("language", language.as_str()),
                    ("include_adult", "false"),
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
        language: Option<&str>,
    ) -> Result<TmdbSearchResponse, AppError> {
        let normalized_query = Self::normalize_search_query(query);
        let media_type = media_type.unwrap_or("multi");
        let page = page.unwrap_or(1).to_string();
        let language = Self::canonical_language(language);
        let cache_key =
            Self::provider_cache_key("search", &[&language, media_type, &page, &normalized_query]);
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
            .search(query, Some(media_type), page.parse().ok(), Some(&language))
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
                .query(&[
                    ("language", "en-US"),
                    ("append_to_response", "alternative_titles,translations"),
                ]),
        );
        self.send_api("movie_detail", request).await
    }

    pub async fn get_tv_detail(&self, tmdb_id: i32) -> Result<TmdbTvDetail, AppError> {
        let request = self.authed(
            self.client
                .get(format!("{}/tv/{}", self.base_url, tmdb_id))
                .query(&[
                    ("language", "en-US"),
                    ("append_to_response", "alternative_titles,translations"),
                ]),
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
        self.send_api_with_limit("season", request, MAX_SEASON_RESPONSE_BYTES)
            .await
    }

    pub async fn get_movie_release_dates(
        &self,
        tmdb_id: i32,
    ) -> Result<TmdbMovieReleaseDates, AppError> {
        if tmdb_id <= 0 {
            return Err(AppError::BadRequest("Invalid TMDB ID".to_string()));
        }
        let request = self.authed(
            self.client
                .get(format!("{}/movie/{}/release_dates", self.base_url, tmdb_id)),
        );
        self.send_api("movie_release_dates", request).await
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
            if media.metadata_level == "detail" && age.num_hours() < 24 {
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
            if media.metadata_level == "detail" && age.num_hours() < 24 {
                Self::touch_media(pool, media.id).await?;
                crate::metrics::record_tmdb_cache(cache_name, "hit");
                return Ok(media.clone());
            }
        }
        crate::metrics::record_tmdb_cache(cache_name, "miss");

        match self.refresh_media_unlocked(pool, tmdb_id, media_type).await {
            Ok(media) => Ok(media),
            Err(error) => {
                if let Some(media) = cached.filter(|media| media.metadata_level == "detail") {
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

    async fn replace_title_aliases(
        tx: &mut Transaction<'_, Postgres>,
        media: &Media,
        alternative_titles: Option<&TmdbAlternativeTitles>,
        translations: Option<&TmdbTranslations>,
    ) -> Result<(), AppError> {
        let (Some(alternative_titles), Some(translations)) = (alternative_titles, translations)
        else {
            return Ok(());
        };
        let aliases =
            Self::collect_title_aliases(&media.media_type, alternative_titles, translations);

        sqlx::query("DELETE FROM media_title_aliases WHERE media_id = $1")
            .bind(media.id)
            .execute(&mut **tx)
            .await?;

        if !aliases.is_empty() {
            let mut query = QueryBuilder::<Postgres>::new(
                "INSERT INTO media_title_aliases \
                 (media_id, kind, language_code, region_code, title) ",
            );
            query.push_values(&aliases, |mut row, alias| {
                row.push_bind(media.id)
                    .push_bind(alias.kind)
                    .push_bind(&alias.language_code)
                    .push_bind(&alias.region_code)
                    .push_bind(&alias.title);
            });
            query
                .push(" ON CONFLICT DO NOTHING")
                .build()
                .execute(&mut **tx)
                .await?;
        }

        sqlx::query("UPDATE media SET title_aliases_cached_at = NOW() WHERE id = $1")
            .bind(media.id)
            .execute(&mut **tx)
            .await?;
        Ok(())
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

        let mut tx = pool.begin().await?;
        let media = sqlx::query_as::<_, Media>(
            r#"INSERT INTO media (tmdb_id, media_type, title, original_title, overview, poster_path, backdrop_path, release_date, status, genres, runtime_minutes, tmdb_vote_average, tmdb_cached_at, last_accessed_at, metadata_level)
            VALUES ($1, 'movie', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW(), 'detail')
            ON CONFLICT (tmdb_id, media_type)
            DO UPDATE SET title = $2, original_title = $3, overview = $4, poster_path = $5, backdrop_path = $6, release_date = $7, status = $8, genres = $9, runtime_minutes = $10, tmdb_vote_average = $11, tmdb_cached_at = NOW(), last_accessed_at = NOW(), metadata_level = 'detail'
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
        .fetch_one(&mut *tx)
        .await?;

        Self::replace_title_aliases(
            &mut tx,
            &media,
            detail.alternative_titles.as_ref(),
            detail.translations.as_ref(),
        )
        .await?;
        tx.commit().await?;
        Ok(media)
    }

    fn collect_release_dates(response: &TmdbMovieReleaseDates) -> Vec<RegionalReleaseDate> {
        let mut seen = HashSet::new();
        let mut releases = Vec::new();

        for country in &response.results {
            let country_code = country.iso_3166_1.trim().to_ascii_uppercase();
            if country_code.len() != 2
                || !country_code.bytes().all(|byte| byte.is_ascii_uppercase())
            {
                continue;
            }

            for release in &country.release_dates {
                if !(1..=6).contains(&release.release_type) {
                    continue;
                }
                let Some(raw_date) = release.release_date.get(..10) else {
                    continue;
                };
                let Ok(release_date) = NaiveDate::parse_from_str(raw_date, "%Y-%m-%d") else {
                    continue;
                };
                let key = (country_code.clone(), release.release_type, release_date);
                if seen.insert(key.clone()) {
                    releases.push(RegionalReleaseDate {
                        country_code: key.0,
                        release_type: key.1,
                        release_date: key.2,
                    });
                }
                if releases.len() == MAX_RELEASE_DATES_PER_MOVIE {
                    return releases;
                }
            }
        }
        releases
    }

    pub async fn refresh_movie_release_dates(
        &self,
        pool: &PgPool,
        media: &Media,
    ) -> Result<usize, AppError> {
        if media.media_type != "movie" || media.tmdb_id <= 0 {
            return Err(AppError::BadRequest(
                "Release dates require a valid movie".to_string(),
            ));
        }

        let response = self.get_movie_release_dates(media.tmdb_id).await?;
        if response.id != media.tmdb_id {
            return Err(AppError::TmdbError(
                "External release data did not match the requested movie".to_string(),
            ));
        }
        let releases = Self::collect_release_dates(&response);
        let mut tx = pool.begin().await?;
        sqlx::query("DELETE FROM media_release_dates WHERE media_id = $1")
            .bind(media.id)
            .execute(&mut *tx)
            .await?;

        if !releases.is_empty() {
            let mut query = QueryBuilder::<Postgres>::new(
                "INSERT INTO media_release_dates \
                 (media_id, country_code, release_type, release_date) ",
            );
            query.push_values(&releases, |mut row, release| {
                row.push_bind(media.id)
                    .push_bind(&release.country_code)
                    .push_bind(release.release_type)
                    .push_bind(release.release_date);
            });
            query.build().execute(&mut *tx).await?;
        }

        tx.commit().await?;
        Ok(releases.len())
    }

    fn schedule_season_numbers(detail: &TmdbTvDetail, today: NaiveDate) -> Vec<i32> {
        let Some(seasons) = &detail.seasons else {
            return Vec::new();
        };
        let available = seasons
            .iter()
            .filter(|season| season.season_number > 0)
            .map(|season| season.season_number)
            .collect::<HashSet<_>>();
        let mut candidates = Vec::new();

        for season_number in [
            detail
                .next_episode_to_air
                .as_ref()
                .map(|episode| episode.season_number),
            detail
                .last_episode_to_air
                .as_ref()
                .map(|episode| episode.season_number),
        ]
        .into_iter()
        .flatten()
        {
            if available.contains(&season_number) && !candidates.contains(&season_number) {
                candidates.push(season_number);
            }
        }

        let earliest = today - chrono::Duration::days(450);
        let latest = today + chrono::Duration::days(180);
        let mut recent = seasons
            .iter()
            .filter(|season| season.season_number > 0)
            .filter(|season| {
                season
                    .air_date
                    .as_deref()
                    .and_then(|date| NaiveDate::parse_from_str(date, "%Y-%m-%d").ok())
                    .is_some_and(|date| date >= earliest && date <= latest)
            })
            .map(|season| season.season_number)
            .collect::<Vec<_>>();
        recent.sort_unstable_by(|left, right| right.cmp(left));

        if let Some(latest_season) = available.iter().max().copied() {
            recent.push(latest_season);
        }
        for season_number in recent {
            if !candidates.contains(&season_number) {
                candidates.push(season_number);
            }
            if candidates.len() == 2 {
                break;
            }
        }
        candidates.truncate(2);
        candidates
    }

    pub async fn refresh_tv_schedule(
        &self,
        pool: &PgPool,
        tmdb_id: i32,
    ) -> Result<usize, AppError> {
        if tmdb_id <= 0 {
            return Err(AppError::BadRequest("Invalid TMDB ID".to_string()));
        }
        let detail = self.get_tv_detail(tmdb_id).await?;
        if detail.id != tmdb_id {
            return Err(AppError::TmdbError(
                "External TV data did not match the requested show".to_string(),
            ));
        }
        let season_numbers = Self::schedule_season_numbers(&detail, Utc::now().date_naive());
        let media = self.upsert_tv(pool, &detail).await?;

        let mut refreshed_seasons = 0;
        for season_number in &season_numbers {
            match self
                .refresh_season_episodes(pool, &media, *season_number)
                .await
            {
                Ok(_) => refreshed_seasons += 1,
                Err(AppError::NotFound(_)) => {
                    log::warn!(
                        "TMDB season not available yet: tmdb_id={tmdb_id} season={season_number}"
                    );
                }
                Err(error) => return Err(error),
            }
        }
        Ok(refreshed_seasons)
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
            r#"INSERT INTO media (tmdb_id, media_type, title, original_title, overview, poster_path, backdrop_path, release_date, status, genres, runtime_minutes, tmdb_vote_average, tmdb_cached_at, last_accessed_at, metadata_level)
            VALUES ($1, 'tv', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW(), 'detail')
            ON CONFLICT (tmdb_id, media_type)
            DO UPDATE SET title = $2, original_title = $3, overview = $4, poster_path = $5, backdrop_path = $6, release_date = $7, status = $8, genres = $9, runtime_minutes = $10, tmdb_vote_average = $11, tmdb_cached_at = NOW(), last_accessed_at = NOW(), metadata_level = 'detail'
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

        Self::replace_title_aliases(
            &mut tx,
            &media,
            detail.alternative_titles.as_ref(),
            detail.translations.as_ref(),
        )
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
        self.cache_season_episodes_with_policy(
            pool,
            media,
            season_number,
            chrono::Duration::hours(24),
            true,
        )
        .await
    }

    async fn refresh_season_episodes(
        &self,
        pool: &PgPool,
        media: &Media,
        season_number: i32,
    ) -> Result<Vec<crate::models::Episode>, AppError> {
        self.cache_season_episodes_with_policy(
            pool,
            media,
            season_number,
            chrono::Duration::zero(),
            false,
        )
        .await
    }

    async fn cache_season_episodes_with_policy(
        &self,
        pool: &PgPool,
        media: &Media,
        season_number: i32,
        max_age: chrono::Duration,
        serve_stale_on_error: bool,
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

        if max_age > chrono::Duration::zero()
            && season
                .episodes_cached_at
                .is_some_and(|cached_at| Utc::now() - cached_at < max_age)
        {
            crate::metrics::record_tmdb_cache("season_episodes", "hit");
            return Ok(cached_episodes);
        }
        crate::metrics::record_tmdb_cache("season_episodes", "miss");

        let tmdb_episodes = match self.get_season_episodes(media.tmdb_id, season_number).await {
            Ok(episodes) => episodes,
            Err(_error) if serve_stale_on_error && !cached_episodes.is_empty() => {
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

    #[test]
    fn title_alias_inputs_are_canonical_and_bounded() {
        assert_eq!(TmdbService::canonical_language(Some("ro-ro")), "ro-RO");
        assert_eq!(TmdbService::canonical_language(Some("invalid")), "en-US");
        assert_eq!(
            TmdbService::normalize_alias_title("  Film\u{0096}\nRomânesc  "),
            Some("Film Românesc".to_string())
        );
        assert!(TmdbService::normalize_alias_title(&"x".repeat(501)).is_none());
    }

    #[test]
    fn regional_release_dates_are_validated_and_deduplicated() {
        let response = TmdbMovieReleaseDates {
            id: 42,
            results: vec![
                TmdbCountryReleaseDates {
                    iso_3166_1: "ro".to_string(),
                    release_dates: vec![
                        TmdbReleaseDate {
                            release_date: "2026-08-14T00:00:00.000Z".to_string(),
                            release_type: 3,
                        },
                        TmdbReleaseDate {
                            release_date: "2026-08-14T12:00:00.000Z".to_string(),
                            release_type: 3,
                        },
                        TmdbReleaseDate {
                            release_date: "not-a-date".to_string(),
                            release_type: 4,
                        },
                    ],
                },
                TmdbCountryReleaseDates {
                    iso_3166_1: "INVALID".to_string(),
                    release_dates: vec![TmdbReleaseDate {
                        release_date: "2026-08-15T00:00:00.000Z".to_string(),
                        release_type: 9,
                    }],
                },
            ],
        };

        let releases = TmdbService::collect_release_dates(&response);

        assert_eq!(releases.len(), 1);
        assert_eq!(releases[0].country_code, "RO");
        assert_eq!(releases[0].release_type, 3);
        assert_eq!(
            releases[0].release_date,
            NaiveDate::from_ymd_opt(2026, 8, 14).unwrap()
        );
    }

    #[test]
    fn schedule_refresh_prioritizes_next_and_current_seasons() {
        let detail: TmdbTvDetail = serde_json::from_value(serde_json::json!({
            "id": 7,
            "name": "Schedule Fixture",
            "seasons": [
                {"id": 70, "season_number": 0, "name": "Specials", "episode_count": 3},
                {"id": 71, "season_number": 1, "name": "Season 1", "episode_count": 10, "air_date": "2024-01-01"},
                {"id": 72, "season_number": 2, "name": "Season 2", "episode_count": 10, "air_date": "2026-06-01"},
                {"id": 73, "season_number": 3, "name": "Season 3", "episode_count": 8, "air_date": "2026-08-01"}
            ],
            "next_episode_to_air": {"season_number": 3},
            "last_episode_to_air": {"season_number": 2}
        }))
        .unwrap();

        assert_eq!(
            TmdbService::schedule_season_numbers(
                &detail,
                NaiveDate::from_ymd_opt(2026, 7, 14).unwrap()
            ),
            vec![3, 2]
        );
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

        let result = service.get_movie_detail(1).await;

        assert!(matches!(result, Err(AppError::TmdbError(_))));
    }

    #[tokio::test]
    async fn season_response_accepts_payload_above_generic_limit() {
        let body = format!(
            r#"{{"episodes":[],"padding":"{}"}}"#,
            "x".repeat(MAX_API_RESPONSE_BYTES)
        );
        assert!(body.len() > MAX_API_RESPONSE_BYTES);
        assert!(body.len() <= MAX_SEASON_RESPONSE_BYTES);
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        )
        .into_bytes();
        let (base_url, request) = response_server(response).await;
        let mut config = config_with_token(None);
        config.tmdb_base_url = base_url;
        let service = TmdbService::new(&config);

        let result = service.get_season_episodes(1, 2).await.unwrap();
        let request = request.await.unwrap();

        assert!(result.episodes.is_empty());
        assert!(request.starts_with("GET /tv/1/season/2?"));
    }

    #[tokio::test]
    async fn season_response_rejects_payload_above_season_limit() {
        let (base_url, _) = response_server(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                MAX_SEASON_RESPONSE_BYTES + 1
            )
            .into_bytes(),
        )
        .await;
        let mut config = config_with_token(None);
        config.tmdb_base_url = base_url;
        let service = TmdbService::new(&config);

        let result = service.get_season_episodes(1, 2).await;

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

        let first = service.get_movie_detail(1).await;
        let second = service.clone().get_movie_detail(1).await;

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
        let result = service.clone().get_movie_detail(1).await;
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

        let result = service.get_movie_detail(1).await;

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
