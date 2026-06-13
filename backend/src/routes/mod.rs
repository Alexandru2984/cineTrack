pub mod auth;
pub mod history;
pub mod lists;
pub mod media;
pub mod stats;
pub mod tracking;
pub mod users;

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
            .configure(stats::configure),
    );
}
