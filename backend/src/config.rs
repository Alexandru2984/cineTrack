use std::{collections::HashSet, env, fmt::Display, str::FromStr};

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
    pub totp_encryption_key: [u8; 32],
    pub jwt_expiry_minutes: i64,
    pub jwt_refresh_expiry_days: i64,
    pub tmdb_api_key: String,
    pub tmdb_read_access_token: Option<String>,
    pub tmdb_base_url: String,
    pub tmdb_image_base_url: String,
    pub tmdb_timeout_seconds: u64,
    pub cors_allowed_origins: Vec<String>,
    /// Concurrent database operations this process may run.
    ///
    /// Hardcoded at ten until now, which is a ceiling nobody could raise
    /// without a rebuild — the wrong property for the one setting that decides
    /// how much traffic the process can serve at once.
    pub database_max_connections: u32,
    pub rate_limit_rps: u32,
    pub rate_limit_burst: u32,
    pub smtp_host: Option<String>,
    pub smtp_port: u16,
    pub smtp_username: Option<String>,
    pub smtp_password: Option<String>,
    pub smtp_from: String,
    pub smtp_timeout_seconds: u64,
    pub expo_push_access_token: Option<String>,
    pub expo_push_timeout_seconds: u64,
    /// Reject passwords found in the Have I Been Pwned breach corpus (k-anonymity).
    /// Defaults on in production, off in development/test so offline runs and the
    /// integration suite are not tied to a third-party lookup.
    pub breached_password_check: bool,
    /// Bearer token the Prometheus scraper must present to read `/metrics`.
    /// Required in production; absent in development leaves the endpoint open.
    pub metrics_bearer_token: Option<String>,
    pub r2: Option<R2Config>,
}

impl Config {
    pub fn from_env() -> Self {
        let app_env = validate_app_env(env::var("APP_ENV").unwrap_or_else(|_| {
            // No default. It used to fall back to `development`, and that is the
            // wrong direction for a default to point: `development` is the
            // setting that relaxes JWT secret strength, CORS, the breached
            // password check and the metrics credential, and logs reset URLs.
            // Every one of those loosens when the variable is *absent*, so a
            // deployment that lost its environment would come up weaker while
            // looking like it had started fine.
            //
            // Nothing depended on the fallback: the production compose file sets
            // it as a literal, the development one reads it from `.env`, and
            // `.env.example` and the README both spell it out. Requiring it
            // costs a clear error on a machine that was already misconfigured,
            // and removes the one way to reach the weak settings by accident.
            panic!("APP_ENV must be set to development, test, or production")
        }));
        let is_production = app_env == "production";
        let jwt_secret = env::var("JWT_SECRET").expect("JWT_SECRET must be set");
        assert!(
            (32..=1024).contains(&jwt_secret.len()),
            "JWT_SECRET must be 32-1024 bytes"
        );
        if is_production {
            let unique_bytes = jwt_secret.bytes().collect::<HashSet<_>>().len();
            assert!(
                unique_bytes >= 16,
                "JWT_SECRET must be generated randomly in production"
            );
        }
        let totp_encryption_key = match env::var("TOTP_ENCRYPTION_KEY") {
            Ok(value) => parse_totp_encryption_key(&value),
            Err(_) if is_production => {
                panic!("TOTP_ENCRYPTION_KEY must be set to 64 hexadecimal characters in production")
            }
            Err(_) => [0xA5; 32],
        };

        let frontend_url = validate_url(
            "FRONTEND_URL",
            env::var("FRONTEND_URL").unwrap_or_else(|_| "http://localhost:5173".to_string()),
            is_production,
            true,
        );
        let cors_allowed_origins = parse_cors_origins(is_production);
        if is_production {
            assert!(
                cors_allowed_origins.contains(&frontend_url),
                "CORS_ALLOWED_ORIGINS must include FRONTEND_URL in production"
            );
        }

        let tmdb_api_key = env::var("TMDB_API_KEY")
            .unwrap_or_else(|_| env::var("API_KEY").expect("TMDB_API_KEY or API_KEY must be set"));
        assert!(
            !tmdb_api_key.trim().is_empty() && tmdb_api_key.len() <= 512,
            "TMDB_API_KEY must be 1-512 bytes"
        );
        let tmdb_read_access_token = env::var("TMDB_READ_ACCESS_TOKEN")
            .ok()
            .filter(|value| !value.trim().is_empty());
        if let Some(token) = &tmdb_read_access_token {
            assert!(
                token.len() <= 4096
                    && !token
                        .bytes()
                        .any(|byte| byte.is_ascii_control() || byte.is_ascii_whitespace()),
                "TMDB_READ_ACCESS_TOKEN has an invalid shape"
            );
        }

        let smtp_host = env::var("SMTP_HOST")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let smtp_username = env::var("SMTP_USERNAME")
            .ok()
            .filter(|value| !value.is_empty());
        let smtp_password = env::var("SMTP_PASSWORD")
            .ok()
            .filter(|value| !value.is_empty());
        let smtp_from =
            env::var("SMTP_FROM").unwrap_or_else(|_| "CineTrack <noreply@localhost>".to_string());
        validate_smtp_config(
            smtp_host.as_deref(),
            smtp_username.as_deref(),
            smtp_password.as_deref(),
            &smtp_from,
            is_production,
        );
        let expo_push_access_token = env::var("EXPO_PUSH_ACCESS_TOKEN")
            .ok()
            .filter(|value| !value.trim().is_empty());
        if let Some(token) = &expo_push_access_token {
            assert!(
                token.len() <= 4096
                    && !token
                        .bytes()
                        .any(|byte| byte.is_ascii_control() || byte.is_ascii_whitespace()),
                "EXPO_PUSH_ACCESS_TOKEN has an invalid shape"
            );
        }

        Self {
            app_env,
            app_host: env::var("APP_HOST").unwrap_or_else(|_| "0.0.0.0".to_string()),
            app_port: bounded_env("APP_PORT", 8080_u16, 1, u16::MAX),
            frontend_url,
            database_url: env::var("DATABASE_URL").expect("DATABASE_URL must be set"),
            jwt_secret,
            totp_encryption_key,
            jwt_expiry_minutes: jwt_expiry_minutes(),
            jwt_refresh_expiry_days: bounded_env("JWT_REFRESH_EXPIRY_DAYS", 30_i64, 1, 90),
            tmdb_api_key,
            // TMDB v4 Read Access Token. When present it is sent as a Bearer
            // header so the credential never appears in request URLs or logs;
            // otherwise the client falls back to the v3 `api_key` query param.
            tmdb_read_access_token,
            tmdb_base_url: validate_url(
                "TMDB_BASE_URL",
                env::var("TMDB_BASE_URL")
                    .unwrap_or_else(|_| "https://api.themoviedb.org/3".to_string()),
                is_production,
                false,
            ),
            tmdb_image_base_url: validate_url(
                "TMDB_IMAGE_BASE_URL",
                env::var("TMDB_IMAGE_BASE_URL")
                    .unwrap_or_else(|_| "https://image.tmdb.org/t/p".to_string()),
                is_production,
                false,
            ),
            tmdb_timeout_seconds: bounded_env("TMDB_TIMEOUT_SECONDS", 10_u64, 1, 60),
            cors_allowed_origins,
            // Twenty by default: roughly two per core on the host this runs
            // on, and well inside PostgreSQL's own limit of a hundred, which
            // the monitoring and migration connections also draw from. Raising
            // it past what the database can serve turns a queue in the
            // application into a queue in PostgreSQL, which is worse — the
            // application at least fails fast when it cannot acquire.
            database_max_connections: bounded_env("DATABASE_MAX_CONNECTIONS", 20_u32, 1, 80),
            rate_limit_rps: bounded_env("RATE_LIMIT_REQUESTS_PER_SECOND", 10_u32, 1, 100),
            rate_limit_burst: bounded_env("RATE_LIMIT_BURST_SIZE", 50_u32, 1, 1000),
            smtp_host,
            smtp_port: bounded_env("SMTP_PORT", 587_u16, 1, u16::MAX),
            smtp_username,
            smtp_password,
            smtp_from,
            smtp_timeout_seconds: bounded_env("SMTP_TIMEOUT_SECONDS", 15_u64, 1, 60),
            expo_push_access_token,
            expo_push_timeout_seconds: bounded_env("EXPO_PUSH_TIMEOUT_SECONDS", 15_u64, 1, 60),
            breached_password_check: bool_env("BREACHED_PASSWORD_CHECK", is_production),
            metrics_bearer_token: metrics_bearer_token(is_production),
            r2: R2Config::from_env(is_production),
        }
    }

    pub fn is_production(&self) -> bool {
        self.app_env == "production"
    }

    /// A configuration with every field set to a safe test value, for tests to
    /// take and adjust.
    ///
    /// Not `#[cfg(test)]`, because the PostgreSQL integration suite is a
    /// separate crate and needs it too. It exists because the alternative —
    /// spelling out the whole struct at each test site — meant that adding one
    /// field broke several unrelated files, which is exactly the pressure that
    /// makes people reach for a default value instead of thinking about what a
    /// new security-relevant setting should be.
    #[doc(hidden)]
    pub fn for_test() -> Self {
        Self {
            app_env: "test".to_string(),
            app_host: "127.0.0.1".to_string(),
            app_port: 0,
            frontend_url: "http://localhost:5173".to_string(),
            database_url: "postgres://example".to_string(),
            database_max_connections: 5,
            jwt_secret: "test_secret_must_be_64_chars_long_so_we_pad_it_here_abcdefghijklmnopq"
                .to_string(),
            totp_encryption_key: [0x42; 32],
            jwt_expiry_minutes: 15,
            jwt_refresh_expiry_days: 30,
            tmdb_api_key: "fake".to_string(),
            tmdb_read_access_token: None,
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
            smtp_timeout_seconds: 15,
            expo_push_access_token: None,
            expo_push_timeout_seconds: 15,
            breached_password_check: false,
            metrics_bearer_token: None,
            r2: None,
        }
    }
}

fn parse_totp_encryption_key(value: &str) -> [u8; 32] {
    let value = value.trim();
    assert!(
        value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "TOTP_ENCRYPTION_KEY must contain exactly 64 hexadecimal characters"
    );
    let decoded = hex::decode(value).expect("validated TOTP encryption key hex");
    decoded
        .try_into()
        .expect("validated TOTP encryption key length")
}

/// The scrape credential for `/metrics`.
///
/// Required in production and refused if weak. The endpoint is served on the
/// application's own port, which on a shared host means any neighbouring
/// process can read it; "nginx does not proxy it" stops being a boundary as
/// soon as something else on the box is curious. Development and test leave it
/// unset, which keeps a local scrape working without ceremony.
fn metrics_bearer_token(is_production: bool) -> Option<String> {
    let token = env::var("METRICS_BEARER_TOKEN")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    match token {
        Some(token) => {
            assert!(
                (32..=512).contains(&token.len()),
                "METRICS_BEARER_TOKEN must be 32-512 bytes"
            );
            assert!(
                !token
                    .bytes()
                    .any(|byte| byte.is_ascii_control() || byte.is_ascii_whitespace()),
                "METRICS_BEARER_TOKEN must not contain whitespace or control characters"
            );
            if is_production {
                let unique_bytes = token.bytes().collect::<HashSet<_>>().len();
                assert!(
                    unique_bytes >= 16,
                    "METRICS_BEARER_TOKEN must be generated randomly in production"
                );
            }
            Some(token)
        }
        None => {
            assert!(
                !is_production,
                "METRICS_BEARER_TOKEN must be set in production; generate one with `openssl rand -hex 32`"
            );
            None
        }
    }
}

fn validate_app_env(value: String) -> String {
    assert!(
        matches!(value.as_str(), "development" | "test" | "production"),
        "APP_ENV must be development, test, or production"
    );
    value
}

fn validate_url(name: &str, value: String, require_https: bool, origin_only: bool) -> String {
    let parsed =
        reqwest::Url::parse(value.trim()).unwrap_or_else(|_| panic!("{name} must be a valid URL"));
    assert!(
        matches!(parsed.scheme(), "http" | "https"),
        "{name} must use HTTP or HTTPS"
    );
    if require_https {
        assert!(
            parsed.scheme() == "https",
            "{name} must use HTTPS in production"
        );
    }
    assert!(
        parsed.username().is_empty() && parsed.password().is_none(),
        "{name} must not contain credentials"
    );
    assert!(
        parsed.query().is_none() && parsed.fragment().is_none(),
        "{name} must not contain a query or fragment"
    );

    if origin_only {
        assert!(parsed.path() == "/", "{name} must contain only an origin");
        parsed.origin().ascii_serialization()
    } else {
        parsed.as_str().trim_end_matches('/').to_string()
    }
}

fn parse_cors_origins(require_https: bool) -> Vec<String> {
    let raw =
        env::var("CORS_ALLOWED_ORIGINS").unwrap_or_else(|_| "http://localhost:5173".to_string());
    let origins = raw
        .split(',')
        .map(|origin| {
            validate_url(
                "CORS_ALLOWED_ORIGINS entry",
                origin.trim().to_string(),
                require_https,
                true,
            )
        })
        .collect::<Vec<_>>();
    assert!(
        (1..=10).contains(&origins.len()),
        "CORS_ALLOWED_ORIGINS must contain 1-10 origins"
    );
    assert!(
        origins.iter().collect::<HashSet<_>>().len() == origins.len(),
        "CORS_ALLOWED_ORIGINS must not contain duplicates"
    );
    origins
}

fn validate_smtp_config(
    host: Option<&str>,
    username: Option<&str>,
    password: Option<&str>,
    from: &str,
    is_production: bool,
) {
    assert!(
        username.is_some() == password.is_some(),
        "SMTP_USERNAME and SMTP_PASSWORD must be configured together"
    );
    assert!(
        host.is_some() || (username.is_none() && password.is_none()),
        "SMTP_HOST is required when SMTP credentials are configured"
    );

    if let Some(host) = host {
        assert!(
            host.len() <= 253
                && !host.contains("://")
                && !host.contains(':')
                && !host.chars().any(char::is_whitespace)
                && !host.chars().any(char::is_control),
            "SMTP_HOST must be a hostname without a scheme or port"
        );
    }
    if let Some(username) = username {
        assert!(username.len() <= 512, "SMTP_USERNAME is too long");
    }
    if let Some(password) = password {
        assert!(password.len() <= 1024, "SMTP_PASSWORD is too long");
    }

    let mailbox = from
        .parse::<lettre::message::Mailbox>()
        .expect("SMTP_FROM must be a valid mailbox");
    if is_production {
        assert!(host.is_some(), "SMTP_HOST is required in production");
        assert!(
            username.is_some() && password.is_some(),
            "SMTP credentials are required in production"
        );
        let domain = mailbox.email.domain().to_ascii_lowercase();
        assert!(
            domain != "localhost"
                && !domain.ends_with(".localhost")
                && !domain.ends_with(".invalid"),
            "SMTP_FROM must use a deliverable domain in production"
        );
    }
}

fn bounded_env<T>(name: &str, default: T, minimum: T, maximum: T) -> T
where
    T: Copy + Display + FromStr + PartialOrd,
{
    let value = env::var(name)
        .unwrap_or_else(|_| default.to_string())
        .parse::<T>()
        .unwrap_or_else(|_| panic!("{name} must be a number"));
    assert!(
        value >= minimum && value <= maximum,
        "{name} must be between {minimum} and {maximum}"
    );
    value
}

fn bool_env(name: &str, default: bool) -> bool {
    match env::var(name) {
        Ok(value) => match value.trim().to_ascii_lowercase().as_str() {
            "true" | "1" | "yes" | "on" => true,
            "false" | "0" | "no" | "off" => false,
            _ => panic!("{name} must be a boolean (true/false)"),
        },
        Err(_) => default,
    }
}

fn jwt_expiry_minutes() -> i64 {
    let minutes = match env::var("JWT_EXPIRY_MINUTES") {
        Ok(value) => value.parse().expect("JWT_EXPIRY_MINUTES must be a number"),
        Err(_) => env::var("JWT_EXPIRY_HOURS")
            .ok()
            .map(|value| {
                value
                    .parse::<i64>()
                    .expect("JWT_EXPIRY_HOURS must be a number")
                    .checked_mul(60)
                    .expect("JWT_EXPIRY_HOURS is too large")
            })
            .unwrap_or(15),
    };
    assert!(
        (5..=60).contains(&minutes),
        "JWT access token expiry must be between 5 and 60 minutes"
    );
    minutes
}

impl R2Config {
    /// Build from env; returns None (storage disabled) unless endpoint, keys and
    /// bucket are all present. Accepts the R2_S3_API or R2_ENDPOINT alias.
    fn from_env(require_https: bool) -> Option<R2Config> {
        let endpoint = env::var("R2_S3_API")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .or_else(|| {
                env::var("R2_ENDPOINT")
                    .ok()
                    .filter(|value| !value.trim().is_empty())
            });
        let access_key_id = env::var("R2_ACCESS_KEY_ID")
            .ok()
            .filter(|value| !value.trim().is_empty());
        let secret_access_key = env::var("R2_SECRET_ACCESS_KEY")
            .ok()
            .filter(|value| !value.trim().is_empty());
        let bucket = env::var("R2_BUCKET")
            .ok()
            .filter(|value| !value.trim().is_empty());
        if endpoint.is_none()
            && access_key_id.is_none()
            && secret_access_key.is_none()
            && bucket.is_none()
        {
            return None;
        }
        assert!(
            endpoint.is_some()
                && access_key_id.is_some()
                && secret_access_key.is_some()
                && bucket.is_some(),
            "R2 endpoint, access key, secret key, and bucket must be configured together"
        );

        let endpoint = validate_url("R2 endpoint", endpoint.unwrap(), require_https, false);
        let access_key_id = access_key_id.unwrap();
        let secret_access_key = secret_access_key.unwrap();
        let bucket = bucket.unwrap();
        assert!(
            access_key_id.len() <= 256 && secret_access_key.len() <= 1024,
            "R2 credentials are too long"
        );
        assert!(
            !bucket.is_empty()
                && bucket.len() <= 255
                && bucket
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_')),
            "R2_BUCKET has an invalid shape"
        );
        let public_base_url = env::var("R2_PUBLIC_BASE_URL")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(|value| validate_url("R2_PUBLIC_BASE_URL", value, require_https, false));
        Some(R2Config {
            endpoint,
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

    /// The three it does accept, so making the variable required did not also
    /// narrow what it may say.
    #[test]
    fn accepts_the_three_known_environments() {
        for value in ["development", "test", "production"] {
            assert_eq!(validate_app_env(value.to_string()), value);
        }
    }

    #[test]
    fn normalizes_and_validates_origins() {
        assert_eq!(
            validate_url(
                "TEST_URL",
                "https://Example.COM:443/".to_string(),
                true,
                true
            ),
            "https://example.com"
        );
        assert_eq!(
            validate_url(
                "TEST_URL",
                "http://localhost:5173/".to_string(),
                false,
                true
            ),
            "http://localhost:5173"
        );
    }

    #[test]
    fn rejects_insecure_or_non_origin_production_urls() {
        assert!(std::panic::catch_unwind(|| {
            validate_url("TEST_URL", "http://example.com".to_string(), true, true)
        })
        .is_err());
        assert!(std::panic::catch_unwind(|| {
            validate_url(
                "TEST_URL",
                "https://example.com/path".to_string(),
                true,
                true,
            )
        })
        .is_err());
        assert!(std::panic::catch_unwind(|| {
            validate_url(
                "TEST_URL",
                "https://user:pass@example.com".to_string(),
                true,
                true,
            )
        })
        .is_err());
    }

    #[test]
    fn accepts_authenticated_production_smtp() {
        validate_smtp_config(
            Some("smtp.example.com"),
            Some("relay-user"),
            Some("relay-secret"),
            "CineTrack <noreply@example.com>",
            true,
        );
    }

    #[test]
    fn rejects_incomplete_or_invalid_production_smtp() {
        assert!(std::panic::catch_unwind(|| {
            validate_smtp_config(
                Some("smtp.example.com:587"),
                Some("relay-user"),
                Some("relay-secret"),
                "CineTrack <noreply@example.com>",
                true,
            )
        })
        .is_err());
        assert!(std::panic::catch_unwind(|| {
            validate_smtp_config(
                Some("smtp.example.com"),
                None,
                None,
                "CineTrack <noreply@example.com>",
                true,
            )
        })
        .is_err());
        assert!(std::panic::catch_unwind(|| {
            validate_smtp_config(
                Some("smtp.example.com"),
                Some("relay-user"),
                Some("relay-secret"),
                "CineTrack <noreply@localhost>",
                true,
            )
        })
        .is_err());
    }

    #[test]
    fn parses_a_256_bit_totp_encryption_key() {
        let key = parse_totp_encryption_key(&"ab".repeat(32));
        assert_eq!(key, [0xAB; 32]);
    }

    #[test]
    fn rejects_malformed_totp_encryption_keys() {
        for value in ["ab", &"zz".repeat(32), &"ab".repeat(33)] {
            assert!(std::panic::catch_unwind(|| parse_totp_encryption_key(value)).is_err());
        }
    }
}
