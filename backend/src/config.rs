use std::env;

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
    pub tmdb_base_url: String,
    pub tmdb_image_base_url: String,
    pub cors_allowed_origins: Vec<String>,
    pub rate_limit_rps: u32,
    pub rate_limit_burst: u32,
}

impl Config {
    pub fn from_env() -> Self {
        Self {
            app_env: env::var("APP_ENV").unwrap_or_else(|_| "development".to_string()),
            app_host: env::var("APP_HOST").unwrap_or_else(|_| "0.0.0.0".to_string()),
            app_port: env::var("APP_PORT")
                .unwrap_or_else(|_| "8080".to_string())
                .parse()
                .expect("APP_PORT must be a number"),
            frontend_url: env::var("FRONTEND_URL")
                .unwrap_or_else(|_| "http://localhost:5173".to_string()),
            database_url: env::var("DATABASE_URL")
                .expect("DATABASE_URL must be set"),
            jwt_secret: env::var("JWT_SECRET")
                .expect("JWT_SECRET must be set"),
            jwt_expiry_hours: env::var("JWT_EXPIRY_HOURS")
                .unwrap_or_else(|_| "24".to_string())
                .parse()
                .expect("JWT_EXPIRY_HOURS must be a number"),
            jwt_refresh_expiry_days: env::var("JWT_REFRESH_EXPIRY_DAYS")
                .unwrap_or_else(|_| "30".to_string())
                .parse()
                .expect("JWT_REFRESH_EXPIRY_DAYS must be a number"),
            tmdb_api_key: env::var("TMDB_API_KEY")
                .unwrap_or_else(|_| env::var("API_KEY").expect("TMDB_API_KEY or API_KEY must be set")),
            tmdb_base_url: env::var("TMDB_BASE_URL")
                .unwrap_or_else(|_| "https://api.themoviedb.org/3".to_string()),
            tmdb_image_base_url: env::var("TMDB_IMAGE_BASE_URL")
                .unwrap_or_else(|_| "https://image.tmdb.org/t/p".to_string()),
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
        }
    }

    pub fn is_production(&self) -> bool {
        self.app_env == "production"
    }
}
