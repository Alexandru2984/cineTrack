use actix_cors::Cors;
use actix_governor::{Governor, GovernorConfigBuilder};
use actix_web::{middleware as actix_middleware, web, App, HttpResponse, HttpServer};

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

use cinetrack::{
    config, db, metrics,
    middleware::rate_limit::TrustedProxyIpKeyExtractor,
    middleware::request_id::{current_request_id, request_id},
    routes,
    services::email::EmailService,
    services::tmdb::TmdbService,
    utils::password,
};

/// Access-log format including the per-request correlation id (set by the
/// request_id middleware and echoed in the X-Request-Id response header).
const LOG_FORMAT: &str = r#"%a "%r" %s %b "%{User-Agent}i" %T req-id=%{x-request-id}o"#;

fn run_healthcheck() -> std::io::Result<()> {
    let port = std::env::var("APP_PORT")
        .unwrap_or_else(|_| "8080".to_string())
        .parse::<u16>()
        .map_err(|err| std::io::Error::new(std::io::ErrorKind::InvalidInput, err))?;
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let timeout = Duration::from_secs(2);
    let mut stream = TcpStream::connect_timeout(&address, timeout)?;
    stream.set_read_timeout(Some(timeout))?;
    stream.set_write_timeout(Some(timeout))?;
    stream
        .write_all(b"GET /api/health HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n\r\n")?;

    let mut status = [0_u8; 12];
    stream.read_exact(&mut status)?;
    if status == *b"HTTP/1.0 200" || status == *b"HTTP/1.1 200" {
        Ok(())
    } else {
        Err(std::io::Error::other("health endpoint returned non-200"))
    }
}

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

    if std::env::args().any(|arg| arg == "--healthcheck") {
        return run_healthcheck();
    }

    init_logger();

    let config = config::Config::from_env();
    password::initialize().await.map_err(|error| {
        log::error!("Failed to initialize password verification: {error:?}");
        std::io::Error::other("failed to initialize password verification")
    })?;
    let pool = db::create_pool(&config.database_url).await;

    if config.is_production() {
        db::ensure_runtime_role_is_restricted(&pool)
            .await
            .map_err(|error| {
                log::error!("Refusing privileged production database role: {error}");
                std::io::Error::other("production database role is overprivileged")
            })?;
    }

    // Run migrations
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("Failed to run database migrations");

    log::info!("Migrations applied successfully");

    // This deployment runs a single backend process and import tasks are
    // in-memory. Any pending/running row found at process start belongs to a
    // task that cannot still exist after the restart, so unblock a safe retry.
    let interrupted_imports = sqlx::query(
        "UPDATE import_jobs
         SET status = 'failed', error = 'Import interrupted by a service restart', updated_at = NOW()
         WHERE status IN ('pending', 'running')",
    )
    .execute(&pool)
    .await
    .map_err(|error| {
        log::error!("Failed to recover interrupted imports: {error}");
        std::io::Error::other("failed to recover interrupted imports")
    })?
    .rows_affected();
    if interrupted_imports > 0 {
        log::warn!("Recovered {interrupted_imports} interrupted import job(s)");
    }

    match cinetrack::services::media_cache::prune_orphaned_media(&pool).await {
        Ok(0) => {}
        Ok(deleted) => log::info!("Pruned {deleted} orphaned media cache row(s) at startup"),
        Err(error) => log::error!("Failed to prune orphaned media cache at startup: {error}"),
    }
    match cinetrack::services::media_cache::prune_provider_response_cache(&pool).await {
        Ok(0) => {}
        Ok(deleted) => {
            log::info!("Pruned {deleted} provider response cache row(s) at startup")
        }
        Err(error) => log::error!("Failed to prune provider response cache at startup: {error}"),
    }
    cinetrack::services::media_cache::start_orphan_pruner(pool.clone());

    let tmdb_service = TmdbService::new(&config);
    let email_service = EmailService::new(&config);

    // Object storage (Cloudflare R2). Optional — features degrade if unset.
    let storage_service = match &config.r2 {
        Some(r2) => {
            match cinetrack::services::storage::StorageService::new(r2, &config.frontend_url) {
                Ok(s) => {
                    log::info!("R2 object storage enabled (bucket configured)");
                    Some(s)
                }
                Err(e) => {
                    log::error!("R2 configured but failed to init: {e}");
                    None
                }
            }
        }
        None => {
            log::info!("R2 not configured; storage features disabled");
            None
        }
    };

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
    // Built once and cloned through Arc into every Actix worker. Building this
    // inside route configuration would multiply the auth burst by worker count.
    let auth_governor_conf = routes::auth::build_rate_limiter();

    log::info!("Starting server at {}:{}", host, port);

    HttpServer::new(move || {
        let auth_governor_conf = auth_governor_conf.clone();
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
            .add(("Referrer-Policy", "strict-origin-when-cross-origin"))
            .add(("Cache-Control", "no-store"))
            .add(("Pragma", "no-cache"));

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
            .app_data(web::Data::new(storage_service.clone()))
            .configure(move |cfg| routes::configure_with_auth_rate_limit(cfg, &auth_governor_conf))
    })
    .bind(format!("{}:{}", host, port))?
    .run()
    .await
}
