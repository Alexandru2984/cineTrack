use actix_cors::Cors;
use actix_governor::{Governor, GovernorConfigBuilder};
use actix_web::{middleware as actix_middleware, web, App, HttpResponse, HttpServer};

use std::io::Write;

use cinetrack::{
    config, db, metrics,
    middleware::rate_limit::TrustedProxyIpKeyExtractor,
    middleware::request_id::{current_request_id, request_id},
    routes,
    services::email::EmailService,
    services::tmdb::TmdbService,
};

/// Access-log format including the per-request correlation id (set by the
/// request_id middleware and echoed in the X-Request-Id response header).
const LOG_FORMAT: &str = r#"%a "%r" %s %b "%{User-Agent}i" %T req-id=%{x-request-id}o"#;

/// Initialize logging. Keeps env_logger's `RUST_LOG`-driven filtering but tags
/// every line with the in-flight request's correlation id, so application and
/// audit logs can be correlated with the access log and the X-Request-Id header.
fn init_logger() {
    env_logger::Builder::from_default_env()
        .format(|buf, record| {
            let ts = buf.timestamp();
            match current_request_id() {
                Some(id) => writeln!(
                    buf,
                    "[{} {} {}] [req={}] {}",
                    ts,
                    record.level(),
                    record.target(),
                    id,
                    record.args()
                ),
                None => writeln!(
                    buf,
                    "[{} {} {}] {}",
                    ts,
                    record.level(),
                    record.target(),
                    record.args()
                ),
            }
        })
        .init();
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    dotenvy::dotenv().ok();
    init_logger();

    let config = config::Config::from_env();
    let pool = db::create_pool(&config.database_url).await;

    // Run migrations
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("Failed to run database migrations");

    log::info!("Migrations applied successfully");

    let tmdb_service = TmdbService::new(&config);
    let email_service = EmailService::new(&config);

    let prometheus = metrics::build();

    let host = config.app_host.clone();
    let port = config.app_port;
    let allowed_origins = config.cors_allowed_origins.clone();

    let governor_conf = GovernorConfigBuilder::default()
        .requests_per_second(config.rate_limit_rps.into())
        .burst_size(config.rate_limit_burst)
        .key_extractor(TrustedProxyIpKeyExtractor)
        .finish()
        .expect("Failed to build rate limiter config");

    log::info!("Starting server at {}:{}", host, port);

    HttpServer::new(move || {
        // Cap request bodies at the application layer (defense-in-depth: nginx
        // also limits, but this protects direct access and returns a clean 400).
        let json_cfg = web::JsonConfig::default()
            .limit(64 * 1024)
            .error_handler(|_err, _req| {
                actix_web::error::InternalError::from_response(
                    "invalid body",
                    HttpResponse::BadRequest().json(serde_json::json!({
                        "error": "400 Bad Request",
                        "message": "Invalid or oversized request body"
                    })),
                )
                .into()
            });

        // Security headers at the app layer too. In production nginx strips the
        // duplicates (proxy_hide_header) and re-adds them, so these only surface
        // when the backend is reached without the reverse proxy.
        let security_headers = actix_middleware::DefaultHeaders::new()
            .add(("X-Content-Type-Options", "nosniff"))
            .add(("X-Frame-Options", "DENY"))
            .add(("Referrer-Policy", "strict-origin-when-cross-origin"));

        let mut cors = Cors::default()
            .allowed_methods(vec!["GET", "POST", "PATCH", "DELETE", "OPTIONS"])
            .allowed_headers(vec![
                actix_web::http::header::AUTHORIZATION,
                actix_web::http::header::CONTENT_TYPE,
                actix_web::http::header::ACCEPT,
            ])
            .supports_credentials()
            .max_age(3600);

        for origin in &allowed_origins {
            cors = cors.allowed_origin(origin);
        }

        App::new()
            .wrap(Governor::new(&governor_conf))
            .wrap(cors)
            .wrap(security_headers)
            .wrap(actix_middleware::from_fn(request_id))
            .wrap(actix_middleware::Logger::new(LOG_FORMAT))
            .wrap(prometheus.clone())
            .app_data(json_cfg)
            .app_data(web::Data::new(pool.clone()))
            .app_data(web::Data::new(config.clone()))
            .app_data(web::Data::new(tmdb_service.clone()))
            .app_data(web::Data::new(email_service.clone()))
            .configure(routes::configure)
    })
    .bind(format!("{}:{}", host, port))?
    .run()
    .await
}
