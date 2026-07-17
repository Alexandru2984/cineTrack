pub mod assets;
pub mod auth;
pub mod calendar;
pub mod client_errors;
pub mod health;
pub mod history;
pub mod import;
pub mod lists;
pub mod media;
pub mod notifications;
pub mod stats;
pub mod tracking;
pub mod users;

use actix_web::web;

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::scope("/api")
            .configure(health::configure)
            .configure(auth::configure)
            // assets before users: the exact /users/me/avatar resource must match
            // before the greedy /users scope claims the prefix.
            .configure(assets::configure)
            .configure(users::configure)
            .configure(notifications::configure)
            .configure(calendar::configure)
            .configure(client_errors::configure)
            .configure(media::configure)
            .configure(tracking::configure)
            .configure(history::configure)
            .configure(lists::configure)
            .configure(stats::configure)
            .configure(import::configure),
    );
}

pub fn configure_with_rate_limits(
    cfg: &mut web::ServiceConfig,
    auth_rate_limiter: &auth::AuthGovernorConfig,
    client_error_rate_limiter: &client_errors::ClientErrorGovernorConfig,
) {
    cfg.service(
        web::scope("/api")
            .configure(health::configure)
            .configure(|cfg| auth::configure_rate_limited(cfg, auth_rate_limiter))
            .configure(assets::configure)
            .configure(users::configure)
            .configure(notifications::configure)
            .configure(calendar::configure)
            .configure(|cfg| client_errors::configure_rate_limited(cfg, client_error_rate_limiter))
            .configure(media::configure)
            .configure(tracking::configure)
            .configure(history::configure)
            .configure(lists::configure)
            .configure(stats::configure)
            .configure(import::configure),
    );
}
