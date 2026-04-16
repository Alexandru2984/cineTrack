pub mod auth;
pub mod users;
pub mod media;
pub mod tracking;
pub mod history;
pub mod lists;
pub mod stats;

use actix_web::web;

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::scope("/api")
            .configure(auth::configure)
            .configure(users::configure)
            .configure(media::configure)
            .configure(tracking::configure)
            .configure(history::configure)
            .configure(lists::configure)
            .configure(stats::configure)
    );
}
