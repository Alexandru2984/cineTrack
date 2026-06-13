use actix_web::{web, HttpResponse};
use sqlx::PgPool;

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::scope("/health")
            .route("", web::get().to(liveness))
            .route("/ready", web::get().to(readiness)),
    );
}

/// Liveness probe: the process is up and serving HTTP. Does not touch the DB.
async fn liveness() -> HttpResponse {
    HttpResponse::Ok().json(serde_json::json!({ "status": "ok" }))
}

/// Readiness probe: verifies the database is reachable. Returns 503 if not,
/// so a load balancer / orchestrator can stop routing traffic to this instance.
async fn readiness(pool: web::Data<PgPool>) -> HttpResponse {
    match sqlx::query_scalar::<_, i32>("SELECT 1")
        .fetch_one(pool.get_ref())
        .await
    {
        Ok(_) => HttpResponse::Ok().json(serde_json::json!({ "status": "ready" })),
        Err(_) => {
            HttpResponse::ServiceUnavailable().json(serde_json::json!({ "status": "unavailable" }))
        }
    }
}
