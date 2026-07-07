pub mod assets;
pub mod auth;
pub mod health;
pub mod history;
pub mod import;
pub mod lists;
pub mod media;
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
            .configure(media::configure)
            .configure(tracking::configure)
            .configure(history::configure)
            .configure(lists::configure)
            .configure(stats::configure)
            .configure(import::configure),
    );
}
