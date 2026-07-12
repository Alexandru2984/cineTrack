use std::env;

/// Cloudflare R2 (S3-compatible) object storage. Optional: when the required
/// vars are absent the app runs with storage features disabled.
#[derive(Clone)]
pub struct R2Config {
    pub endpoint: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    pub bucket: String,
    /// Public base URL for objects (custom domain or r2.dev). When None, assets
    /// are served through the backend proxy instead of a direct public URL.
    pub public_base_url: Option<String>,
}

#[derive(Clone)]
pub struct Config {
    pub app_env: String,
    pub app_host: String,
    pub app_port: u16,
    pub frontend_url: String,
    pub database_url: String,
    pub jwt_secret: String,
    pub jwt_expiry_hours: i64,
    pub jwt_refresh_expiry_days: i64,
    pub tmdb_api_key: String,
    pub tmdb_read_access_token: Option<String>,
    pub tmdb_base_url: String,
    pub tmdb_image_base_url: String,
    pub tmdb_timeout_seconds: u64,
    pub cors_allowed_origins: Vec<String>,
    pub rate_limit_rps: u32,
    pub rate_limit_burst: u32,
    pub smtp_host: Option<String>,
    pub smtp_port: u16,
    pub smtp_username: Option<String>,
    pub smtp_password: Option<String>,
    pub smtp_from: String,
    pub r2: Option<R2Config>,
}

impl Config {
    pub fn from_env() -> Self {
        let app_env =
            validate_app_env(env::var("APP_ENV").unwrap_or_else(|_| "development".to_string()));
        let jwt_secret = env::var("JWT_SECRET").expect("JWT_SECRET must be set");
        assert!(
            jwt_secret.len() >= 32,
            "JWT_SECRET must be at least 32 bytes"
        );

        Self {
            app_env,
            app_host: env::var("APP_HOST").unwrap_or_else(|_| "0.0.0.0".to_string()),
            app_port: env::var("APP_PORT")
                .unwrap_or_else(|_| "8080".to_string())
                .parse()
                .expect("APP_PORT must be a number"),
            frontend_url: env::var("FRONTEND_URL")
                .unwrap_or_else(|_| "http://localhost:5173".to_string()),
            database_url: env::var("DATABASE_URL").expect("DATABASE_URL must be set"),
            jwt_secret,
            jwt_expiry_hours: env::var("JWT_EXPIRY_HOURS")
                .unwrap_or_else(|_| "1".to_string())
                .parse()
                .expect("JWT_EXPIRY_HOURS must be a number"),
            jwt_refresh_expiry_days: env::var("JWT_REFRESH_EXPIRY_DAYS")
                .unwrap_or_else(|_| "30".to_string())
                .parse()
                .expect("JWT_REFRESH_EXPIRY_DAYS must be a number"),
            tmdb_api_key: env::var("TMDB_API_KEY").unwrap_or_else(|_| {
                env::var("API_KEY").expect("TMDB_API_KEY or API_KEY must be set")
            }),
            // TMDB v4 Read Access Token. When present it is sent as a Bearer
            // header so the credential never appears in request URLs or logs;
            // otherwise the client falls back to the v3 `api_key` query param.
            tmdb_read_access_token: env::var("TMDB_READ_ACCESS_TOKEN")
                .ok()
                .filter(|s| !s.trim().is_empty()),
            tmdb_base_url: env::var("TMDB_BASE_URL")
                .unwrap_or_else(|_| "https://api.themoviedb.org/3".to_string()),
            tmdb_image_base_url: env::var("TMDB_IMAGE_BASE_URL")
                .unwrap_or_else(|_| "https://image.tmdb.org/t/p".to_string()),
            tmdb_timeout_seconds: env::var("TMDB_TIMEOUT_SECONDS")
                .unwrap_or_else(|_| "10".to_string())
                .parse()
                .expect("TMDB_TIMEOUT_SECONDS must be a number"),
            cors_allowed_origins: env::var("CORS_ALLOWED_ORIGINS")
                .unwrap_or_else(|_| "http://localhost:5173".to_string())
                .split(',')
                .map(|s| s.trim().to_string())
                .collect(),
            rate_limit_rps: env::var("RATE_LIMIT_REQUESTS_PER_SECOND")
                .unwrap_or_else(|_| "10".to_string())
                .parse()
                .expect("RATE_LIMIT_REQUESTS_PER_SECOND must be a number"),
            rate_limit_burst: env::var("RATE_LIMIT_BURST_SIZE")
                .unwrap_or_else(|_| "50".to_string())
                .parse()
                .expect("RATE_LIMIT_BURST_SIZE must be a number"),
            smtp_host: env::var("SMTP_HOST").ok().filter(|s| !s.is_empty()),
            smtp_port: env::var("SMTP_PORT")
                .unwrap_or_else(|_| "587".to_string())
                .parse()
                .expect("SMTP_PORT must be a number"),
            smtp_username: env::var("SMTP_USERNAME").ok().filter(|s| !s.is_empty()),
            smtp_password: env::var("SMTP_PASSWORD").ok().filter(|s| !s.is_empty()),
            smtp_from: env::var("SMTP_FROM")
                .unwrap_or_else(|_| "CineTrack <noreply@localhost>".to_string()),
            r2: R2Config::from_env(),
        }
    }

    pub fn is_production(&self) -> bool {
        self.app_env == "production"
    }
}

fn validate_app_env(value: String) -> String {
    assert!(
        matches!(value.as_str(), "development" | "test" | "production"),
        "APP_ENV must be development, test, or production"
    );
    value
}

impl R2Config {
    /// Build from env; returns None (storage disabled) unless endpoint, keys and
    /// bucket are all present. Accepts the R2_S3_API or R2_ENDPOINT alias.
    fn from_env() -> Option<R2Config> {
        let endpoint = env::var("R2_S3_API")
            .or_else(|_| env::var("R2_ENDPOINT"))
            .ok()
            .filter(|s| !s.trim().is_empty())?;
        let access_key_id = env::var("R2_ACCESS_KEY_ID")
            .ok()
            .filter(|s| !s.trim().is_empty())?;
        let secret_access_key = env::var("R2_SECRET_ACCESS_KEY")
            .ok()
            .filter(|s| !s.trim().is_empty())?;
        let bucket = env::var("R2_BUCKET")
            .ok()
            .filter(|s| !s.trim().is_empty())?;
        let public_base_url = env::var("R2_PUBLIC_BASE_URL")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.trim_end_matches('/').to_string());
        Some(R2Config {
            endpoint: endpoint.trim_end_matches('/').to_string(),
            access_key_id,
            secret_access_key,
            bucket,
            public_base_url,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_known_application_environments() {
        for value in ["development", "test", "production"] {
            assert_eq!(validate_app_env(value.to_string()), value);
        }
    }

    #[test]
    #[should_panic(expected = "APP_ENV must be development, test, or production")]
    fn rejects_unknown_application_environment() {
        validate_app_env("prod".to_string());
    }
}
