use actix_web::{
    body::MessageBody,
    dev::{ServiceRequest, ServiceResponse},
    http::header::{HeaderName, HeaderValue},
    middleware::Next,
    Error, HttpMessage,
};
use uuid::Uuid;

pub const REQUEST_ID_HEADER: &str = "x-request-id";

tokio::task_local! {
    /// The current request's correlation id, set for the whole downstream future
    /// so any log emitted while handling the request can be tagged with it.
    static REQUEST_ID: String;
}

/// Per-request correlation id, stored in the request extensions for handlers to
/// read and accessible to logs.
#[derive(Debug, Clone)]
pub struct RequestId(pub String);

/// The correlation id of the request currently being handled, if any. Returns
/// `None` outside of a request (e.g. startup logs). Used by the log formatter.
pub fn current_request_id() -> Option<String> {
    REQUEST_ID.try_with(|id| id.clone()).ok()
}

/// Generate a fresh correlation id for every request, make it available to all
/// downstream logs via a task-local, and echo it back in the `X-Request-Id`
/// response header. Client-supplied values are deliberately ignored so the id
/// cannot be spoofed to poison logs.
pub async fn request_id(
    req: ServiceRequest,
    next: Next<impl MessageBody>,
) -> Result<ServiceResponse<impl MessageBody>, Error> {
    let id = Uuid::new_v4().to_string();
    req.extensions_mut().insert(RequestId(id.clone()));

    // Scope the task-local around the downstream call so handler/service logs
    // resolve `current_request_id()` to this id.
    let mut res = REQUEST_ID.scope(id.clone(), next.call(req)).await?;

    if let Ok(value) = HeaderValue::from_str(&id) {
        res.headers_mut()
            .insert(HeaderName::from_static(REQUEST_ID_HEADER), value);
    }

    Ok(res)
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::{middleware::from_fn, test, web, App, HttpResponse};

    async fn ok() -> HttpResponse {
        HttpResponse::Ok().finish()
    }

    fn header_value<B>(resp: &ServiceResponse<B>) -> String {
        resp.headers()
            .get(REQUEST_ID_HEADER)
            .expect("response should carry an X-Request-Id header")
            .to_str()
            .unwrap()
            .to_string()
    }

    #[actix_web::test]
    async fn adds_a_valid_uuid_request_id() {
        let app = test::init_service(
            App::new()
                .wrap(from_fn(request_id))
                .route("/", web::get().to(ok)),
        )
        .await;

        let resp = test::call_service(&app, test::TestRequest::get().uri("/").to_request()).await;
        let id = header_value(&resp);
        assert!(Uuid::parse_str(&id).is_ok(), "id should be a UUID: {id}");
    }

    #[actix_web::test]
    async fn generates_a_unique_id_per_request() {
        let app = test::init_service(
            App::new()
                .wrap(from_fn(request_id))
                .route("/", web::get().to(ok)),
        )
        .await;

        let first = header_value(
            &test::call_service(&app, test::TestRequest::get().uri("/").to_request()).await,
        );
        let second = header_value(
            &test::call_service(&app, test::TestRequest::get().uri("/").to_request()).await,
        );
        assert_ne!(first, second);
    }

    #[actix_web::test]
    async fn ignores_client_supplied_id() {
        let app = test::init_service(
            App::new()
                .wrap(from_fn(request_id))
                .route("/", web::get().to(ok)),
        )
        .await;

        let req = test::TestRequest::get()
            .uri("/")
            .insert_header((REQUEST_ID_HEADER, "spoofed-by-client"))
            .to_request();
        let id = header_value(&test::call_service(&app, req).await);
        assert_ne!(id, "spoofed-by-client");
        assert!(Uuid::parse_str(&id).is_ok());
    }

    #[actix_web::test]
    async fn exposes_request_id_to_handler_via_task_local() {
        // The handler reads current_request_id() and returns it; it must match the
        // X-Request-Id header, proving logs in the same task can resolve the id.
        async fn echo_id() -> HttpResponse {
            HttpResponse::Ok().body(current_request_id().unwrap_or_default())
        }

        let app = test::init_service(
            App::new()
                .wrap(from_fn(request_id))
                .route("/", web::get().to(echo_id)),
        )
        .await;

        let resp = test::call_service(&app, test::TestRequest::get().uri("/").to_request()).await;
        let header_id = header_value(&resp);
        let body = test::read_body(resp).await;
        let body_id = String::from_utf8(body.to_vec()).unwrap();

        assert!(!body_id.is_empty());
        assert_eq!(body_id, header_id);
    }

    #[actix_web::test]
    async fn current_request_id_is_none_outside_a_request() {
        assert!(current_request_id().is_none());
    }
}
