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
pub mod push;
pub mod stats;
pub mod tracking;
pub mod users;

use actix_governor::governor::middleware::NoOpMiddleware;
use actix_governor::{Governor, GovernorConfig};
use actix_web::web;

use crate::middleware::rate_limit::TrustedProxyIpKeyExtractor;

/// The limiter every non-image API route shares. Env-driven via
/// `RATE_LIMIT_REQUESTS_PER_SECOND` / `RATE_LIMIT_BURST_SIZE`.
pub type SharedGovernorConfig = GovernorConfig<TrustedProxyIpKeyExtractor, NoOpMiddleware>;

pub fn configure(cfg: &mut web::ServiceConfig) {
    // Same split as the rate-limited path, minus the limiters: public images
    // are top-level scopes registered before /api.
    assets::configure_public_images_unlimited(cfg);

    cfg.service(
        web::scope("/api")
            .configure(health::configure)
            .configure(auth::configure)
            // assets before users: the exact /users/me/avatar resource must match
            // before the greedy /users scope claims the prefix.
            .configure(assets::configure)
            .configure(users::configure)
            .configure(notifications::configure)
            .configure(push::configure)
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
    push_rate_limiter: &push::PushGovernorConfig,
    image_rate_limiter: &assets::ImageGovernorConfig,
    shared_rate_limiter: &SharedGovernorConfig,
) {
    // Public images first, on their own generous budget: a grid of cards asks
    // for dozens at once, and under the shared API limit that burst came back as
    // 429s — a poster that never loads. These are top-level `/api/img` and
    // `/api/assets` scopes, matched before the `/api` scope below.
    assets::configure_public_images(cfg, image_rate_limiter);

    cfg.service(
        web::scope("/api")
            // The shared limiter now wraps only the non-image API, not every
            // request via the App, so images are not double-counted.
            .wrap(Governor::new(shared_rate_limiter))
            .configure(health::configure)
            .configure(|cfg| auth::configure_rate_limited(cfg, auth_rate_limiter))
            .configure(assets::configure)
            .configure(users::configure)
            .configure(notifications::configure)
            .configure(|cfg| push::configure_rate_limited(cfg, push_rate_limiter))
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
