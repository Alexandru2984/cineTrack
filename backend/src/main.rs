mod config;
mod db;
mod dto;
mod errors;
mod middleware;
mod models;
mod routes;
mod services;
mod utils;

use actix_cors::Cors;
use actix_governor::{Governor, GovernorConfigBuilder};
use actix_web::{web, App, HttpServer, middleware as actix_middleware};
use services::tmdb::TmdbService;

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    dotenvy::dotenv().ok();
    env_logger::init();

    let config = config::Config::from_env();
    let pool = db::create_pool(&config.database_url).await;

    // Run migrations
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("Failed to run database migrations");

    log::info!("Migrations applied successfully");

    let tmdb_service = TmdbService::new(&config);

    let host = config.app_host.clone();
    let port = config.app_port;
    let allowed_origins = config.cors_allowed_origins.clone();

    let governor_conf = GovernorConfigBuilder::default()
        .per_second(config.rate_limit_rps.into())
        .burst_size(config.rate_limit_burst)
        .finish()
        .expect("Failed to build rate limiter config");

    log::info!("Starting server at {}:{}", host, port);

    HttpServer::new(move || {
        let mut cors = Cors::default()
            .allowed_methods(vec!["GET", "POST", "PATCH", "DELETE", "OPTIONS"])
            .allowed_headers(vec![
                actix_web::http::header::AUTHORIZATION,
                actix_web::http::header::CONTENT_TYPE,
                actix_web::http::header::ACCEPT,
            ])
            .max_age(3600);

        for origin in &allowed_origins {
            cors = cors.allowed_origin(origin);
        }

        App::new()
            .wrap(Governor::new(&governor_conf))
            .wrap(cors)
            .wrap(actix_middleware::Logger::default())
            .app_data(web::Data::new(pool.clone()))
            .app_data(web::Data::new(config.clone()))
            .app_data(web::Data::new(tmdb_service.clone()))
            .configure(routes::configure)
    })
    .bind(format!("{}:{}", host, port))?
    .run()
    .await
}
