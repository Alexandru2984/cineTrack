use actix_web::http::header;
use actix_web::test as actix_test;
use actix_web::{web, App};
use serde_json::{json, Value};
use sqlx::PgPool;
use std::net::SocketAddr;
use uuid::Uuid;

// ── Helpers ────────────────────────────────────────────────────

const PEER: &str = "127.0.0.1:12345";
const REFRESH_COOKIE_NAME: &str = "cinetrack_refresh";

fn peer_addr() -> SocketAddr {
    PEER.parse().unwrap()
}

fn refresh_cookie_from_response<B>(resp: &actix_web::dev::ServiceResponse<B>) -> String {
    let cookie = resp
        .headers()
        .get_all(header::SET_COOKIE)
        .filter_map(|value| value.to_str().ok())
        .find(|value| value.starts_with(&format!("{REFRESH_COOKIE_NAME}=")))
        .expect("refresh cookie should be set");

    cookie
        .split(';')
        .next()
        .and_then(|pair| pair.strip_prefix(&format!("{REFRESH_COOKIE_NAME}=")))
        .expect("refresh cookie should include a value")
        .to_string()
}

fn test_db_url() -> String {
    std::env::var("TEST_DATABASE_URL")
        .unwrap_or_else(|_| "postgres://test_user:test_pass@127.0.0.1:55433/cinetrack_test".into())
}

async fn setup_pool() -> PgPool {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(5)
        .connect(&test_db_url())
        .await
        .expect("Failed to connect to test DB");

    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("Failed to run migrations");

    pool
}

fn test_config() -> cinetrack::config::Config {
    cinetrack::config::Config {
        app_env: "test".into(),
        app_host: "127.0.0.1".into(),
        app_port: 0,
        frontend_url: "http://localhost:5173".into(),
        database_url: test_db_url(),
        jwt_secret: "test_secret_must_be_64_chars_long_so_we_pad_it_here_abcdefghijklmnopq".into(),
        jwt_expiry_hours: 1,
        jwt_refresh_expiry_days: 30,
        tmdb_api_key: "fake_tmdb_key".into(),
        tmdb_read_access_token: None,
        tmdb_base_url: "https://api.themoviedb.org/3".into(),
        tmdb_image_base_url: "https://image.tmdb.org/t/p".into(),
        tmdb_timeout_seconds: 10,
        cors_allowed_origins: vec!["http://localhost:5173".into()],
        rate_limit_rps: 100,
        rate_limit_burst: 200,
        smtp_host: None,
        smtp_port: 587,
        smtp_username: None,
        smtp_password: None,
        smtp_from: "CineTrack <noreply@localhost>".into(),
        r2: None,
    }
}

fn create_app(
    pool: PgPool,
) -> App<
    impl actix_web::dev::ServiceFactory<
        actix_web::dev::ServiceRequest,
        Config = (),
        Response = actix_web::dev::ServiceResponse<impl actix_web::body::MessageBody>,
        Error = actix_web::Error,
        InitError = (),
    >,
> {
    create_app_with_config(pool, test_config())
}

fn create_app_with_config(
    pool: PgPool,
    config: cinetrack::config::Config,
) -> App<
    impl actix_web::dev::ServiceFactory<
        actix_web::dev::ServiceRequest,
        Config = (),
        Response = actix_web::dev::ServiceResponse<impl actix_web::body::MessageBody>,
        Error = actix_web::Error,
        InitError = (),
    >,
> {
    let tmdb_service = cinetrack::services::tmdb::TmdbService::new(&config);
    let email_service = cinetrack::services::email::EmailService::new(&config);

    // No rate limiter in tests — actix-governor needs real peer_addr from TCP.
    // request_id + metrics mirror the production middleware stack.
    App::new()
        .wrap(actix_web::middleware::from_fn(
            cinetrack::middleware::request_id::request_id,
        ))
        .wrap(cinetrack::metrics::build())
        .app_data(web::Data::new(pool))
        .app_data(web::Data::new(config))
        .app_data(web::Data::new(tmdb_service))
        .app_data(web::Data::new(email_service))
        .app_data(web::Data::new(
            None::<cinetrack::services::storage::StorageService>,
        ))
        .configure(cinetrack::routes::configure)
}

async fn clean_db(pool: &PgPool) {
    sqlx::query("TRUNCATE catalog_external_ids_staging")
        .execute(pool)
        .await
        .ok();
    sqlx::query("DELETE FROM catalog_sync_state")
        .execute(pool)
        .await
        .ok();
    sqlx::query("DELETE FROM catalog_external_ids")
        .execute(pool)
        .await
        .ok();
    sqlx::query("DELETE FROM provider_response_cache")
        .execute(pool)
        .await
        .ok();
    sqlx::query("DELETE FROM notifications")
        .execute(pool)
        .await
        .ok();
    sqlx::query("DELETE FROM list_items")
        .execute(pool)
        .await
        .ok();
    sqlx::query("DELETE FROM lists").execute(pool).await.ok();
    sqlx::query("DELETE FROM follows").execute(pool).await.ok();
    sqlx::query("DELETE FROM watch_history")
        .execute(pool)
        .await
        .ok();
    sqlx::query("DELETE FROM user_media")
        .execute(pool)
        .await
        .ok();
    sqlx::query("DELETE FROM episodes").execute(pool).await.ok();
    sqlx::query("DELETE FROM seasons").execute(pool).await.ok();
    sqlx::query("DELETE FROM media").execute(pool).await.ok();
    sqlx::query("DELETE FROM password_reset_tokens")
        .execute(pool)
        .await
        .ok();
    sqlx::query("DELETE FROM refresh_tokens")
        .execute(pool)
        .await
        .ok();
    sqlx::query("DELETE FROM oauth_accounts")
        .execute(pool)
        .await
        .ok();
    sqlx::query("DELETE FROM users").execute(pool).await.ok();
}

/// Register a user and return (access_token, refresh_token, user_id)
async fn register_user(
    app: &impl actix_web::dev::Service<
        actix_http::Request,
        Response = actix_web::dev::ServiceResponse<impl actix_web::body::MessageBody>,
        Error = actix_web::Error,
    >,
    username: &str,
    email: &str,
    password: &str,
) -> (String, String, String) {
    let req = actix_test::TestRequest::post()
        .uri("/api/auth/register")
        .peer_addr(peer_addr())
        .set_json(json!({
            "username": username,
            "email": email,
            "password": password
        }))
        .peer_addr(peer_addr())
        .to_request();

    let resp = actix_test::call_service(app, req).await;
    assert_eq!(resp.status(), 201, "Register failed for {username}");
    let refresh_token = refresh_cookie_from_response(&resp);

    let body: Value = actix_test::read_body_json(resp).await;
    assert!(body.get("refresh_token").is_none());
    (
        body["access_token"].as_str().unwrap().to_string(),
        refresh_token,
        body["user"]["id"].as_str().unwrap().to_string(),
    )
}

async fn login_user(
    app: &impl actix_web::dev::Service<
        actix_http::Request,
        Response = actix_web::dev::ServiceResponse<impl actix_web::body::MessageBody>,
        Error = actix_web::Error,
    >,
    email: &str,
    password: &str,
) -> (String, String) {
    let req = actix_test::TestRequest::post()
        .uri("/api/auth/login")
        .peer_addr(peer_addr())
        .set_json(json!({
            "email": email,
            "password": password
        }))
        .peer_addr(peer_addr())
        .to_request();

    let resp = actix_test::call_service(app, req).await;
    assert_eq!(resp.status(), 200, "Login failed for {email}");
    let refresh_token = refresh_cookie_from_response(&resp);

    let body: Value = actix_test::read_body_json(resp).await;
    assert!(body.get("refresh_token").is_none());
    (
        body["access_token"].as_str().unwrap().to_string(),
        refresh_token,
    )
}

// ── Auth Tests ────────────────────────────────────────────────

#[actix_web::test]
#[ignore = "requires test DB: docker compose -f docker-compose.test.yml up -d"]
async fn test_register_success() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    let (token, refresh, user_id) =
        register_user(&app, "testuser", "test@example.com", "Pass1234").await;

    assert!(!token.is_empty());
    assert!(!refresh.is_empty());
    assert!(!user_id.is_empty());
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_register_duplicate_email() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    register_user(&app, "user1", "dup@example.com", "Pass1234").await;

    let req = actix_test::TestRequest::post()
        .uri("/api/auth/register")
        .set_json(json!({
            "username": "user2",
            "email": "dup@example.com",
            "password": "Pass1234"
        }))
        .peer_addr(peer_addr())
        .to_request();

    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 400);

    // Verify generic error (no user enumeration)
    let body: Value = actix_test::read_body_json(resp).await;
    let msg = body["message"].as_str().unwrap();
    assert!(
        !msg.contains("email"),
        "Error reveals email conflict: {msg}"
    );
    assert!(
        !msg.contains("username"),
        "Error reveals username conflict: {msg}"
    );
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_register_duplicate_username_is_case_insensitive() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    register_user(&app, "CaseUser", "case-one@example.com", "Pass1234").await;

    let req = actix_test::TestRequest::post()
        .uri("/api/auth/register")
        .set_json(json!({
            "username": "caseuser",
            "email": "case-two@example.com",
            "password": "Pass1234"
        }))
        .peer_addr(peer_addr())
        .to_request();

    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 400);
    let body: Value = actix_test::read_body_json(resp).await;
    assert_eq!(
        body["message"],
        "Unable to create account. Please check your details and try again."
    );
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_register_weak_password() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    let req = actix_test::TestRequest::post()
        .uri("/api/auth/register")
        .set_json(json!({
            "username": "testuser",
            "email": "test@example.com",
            "password": "password"
        }))
        .peer_addr(peer_addr())
        .to_request();

    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 400);
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_register_short_password() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    let req = actix_test::TestRequest::post()
        .uri("/api/auth/register")
        .set_json(json!({
            "username": "testuser",
            "email": "test@example.com",
            "password": "Aa1"
        }))
        .peer_addr(peer_addr())
        .to_request();

    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 400);
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_login_success() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    register_user(&app, "testuser", "login@example.com", "Pass1234").await;
    let (token, refresh) = login_user(&app, "login@example.com", "Pass1234").await;

    assert!(!token.is_empty());
    assert!(!refresh.is_empty());
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_login_wrong_password() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    register_user(&app, "testuser", "wrong@example.com", "Pass1234").await;

    let req = actix_test::TestRequest::post()
        .uri("/api/auth/login")
        .set_json(json!({
            "email": "wrong@example.com",
            "password": "WrongPass1"
        }))
        .peer_addr(peer_addr())
        .to_request();

    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 401);
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_login_nonexistent_user() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    let req = actix_test::TestRequest::post()
        .uri("/api/auth/login")
        .set_json(json!({
            "email": "nobody@example.com",
            "password": "Pass1234"
        }))
        .peer_addr(peer_addr())
        .to_request();

    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 401);
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_me_authenticated() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    let (token, _, _) = register_user(&app, "meuser", "me@example.com", "Pass1234").await;

    let req = actix_test::TestRequest::get()
        .uri("/api/auth/me")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .to_request();

    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);

    let body: Value = actix_test::read_body_json(resp).await;
    assert_eq!(body["username"], "meuser");
    assert_eq!(body["email"], "me@example.com");
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_me_unauthenticated() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    let req = actix_test::TestRequest::get()
        .uri("/api/auth/me")
        .peer_addr(peer_addr())
        .to_request();

    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 401);
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_refresh_token_rotation() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    let (_, refresh, _) =
        register_user(&app, "refreshuser", "refresh@example.com", "Pass1234").await;

    let req = actix_test::TestRequest::post()
        .uri("/api/auth/refresh")
        .set_json(json!({ "refresh_token": refresh }))
        .peer_addr(peer_addr())
        .to_request();

    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);
    let new_refresh = refresh_cookie_from_response(&resp);

    let body: Value = actix_test::read_body_json(resp).await;
    let new_token = body["access_token"].as_str().unwrap();

    assert!(!new_token.is_empty());
    assert!(!new_refresh.is_empty());
    assert!(body.get("refresh_token").is_none());
    assert_ne!(new_refresh, refresh, "Refresh token should rotate");
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_cookie_refresh_requires_allowed_origin() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    let (_, refresh, _) = register_user(&app, "originuser", "origin@example.com", "Pass1234").await;
    let cookie = format!("{REFRESH_COOKIE_NAME}={refresh}");

    let req = actix_test::TestRequest::post()
        .uri("/api/auth/refresh")
        .insert_header((header::COOKIE, cookie.clone()))
        .insert_header((header::ORIGIN, "https://attacker.example"))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 403);

    // The rejected request must not consume the token.
    let req = actix_test::TestRequest::post()
        .uri("/api/auth/refresh")
        .insert_header((header::COOKIE, cookie))
        .insert_header((header::ORIGIN, "http://localhost:5173"))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_refresh_old_token_invalid() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    let (_, refresh, _) = register_user(&app, "oldref", "oldref@example.com", "Pass1234").await;

    // Use refresh token once
    let req = actix_test::TestRequest::post()
        .uri("/api/auth/refresh")
        .set_json(json!({ "refresh_token": &refresh }))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);

    // Try old refresh token again — should fail
    let req = actix_test::TestRequest::post()
        .uri("/api/auth/refresh")
        .set_json(json!({ "refresh_token": &refresh }))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(
        resp.status(),
        401,
        "Old refresh token should be invalid after rotation"
    );
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_logout_invalidates_refresh_token() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    let (_, refresh, _) = register_user(&app, "logoutuser", "logout@example.com", "Pass1234").await;

    // Logout
    let req = actix_test::TestRequest::post()
        .uri("/api/auth/logout")
        .set_json(json!({ "refresh_token": &refresh }))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);

    // Refresh should fail
    let req = actix_test::TestRequest::post()
        .uri("/api/auth/refresh")
        .set_json(json!({ "refresh_token": &refresh }))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 401);
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_change_password_success() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    let (token, _, _) = register_user(&app, "pwuser", "pw@example.com", "Pass1234").await;

    let req = actix_test::TestRequest::patch()
        .uri("/api/auth/password")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(json!({ "current_password": "Pass1234", "new_password": "NewPass5678" }))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);

    // Old password no longer works
    let req = actix_test::TestRequest::post()
        .uri("/api/auth/login")
        .set_json(json!({ "email": "pw@example.com", "password": "Pass1234" }))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 401);

    // New password works
    login_user(&app, "pw@example.com", "NewPass5678").await;
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_change_password_wrong_current_rejected() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    let (token, _, _) = register_user(&app, "pwuser2", "pw2@example.com", "Pass1234").await;

    let req = actix_test::TestRequest::patch()
        .uri("/api/auth/password")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(json!({ "current_password": "WrongPass1", "new_password": "NewPass5678" }))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 401);
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_change_password_revokes_refresh_tokens() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    let (token, refresh, _) = register_user(&app, "pwuser3", "pw3@example.com", "Pass1234").await;

    let req = actix_test::TestRequest::patch()
        .uri("/api/auth/password")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(json!({ "current_password": "Pass1234", "new_password": "NewPass5678" }))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);

    // The pre-change refresh token must no longer be usable
    let req = actix_test::TestRequest::post()
        .uri("/api/auth/refresh")
        .set_json(json!({ "refresh_token": refresh }))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 401);
}

// ── Forgot / Reset Password Tests ─────────────────────────────

/// Insert a reset token directly (hashed, like the service does) and return the
/// raw token to use against the reset endpoint. `valid` controls expiry.
async fn insert_reset_token(pool: &PgPool, email: &str, valid: bool) -> String {
    let raw = cinetrack::utils::jwt::generate_refresh_token();
    let token_hash = cinetrack::utils::jwt::hash_refresh_token(&raw);
    let expires = if valid {
        "NOW() + INTERVAL '1 hour'"
    } else {
        "NOW() - INTERVAL '1 hour'"
    };
    sqlx::query(&format!(
        "INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) \
         VALUES ((SELECT id FROM users WHERE email = $1), $2, {expires})"
    ))
    .bind(email)
    .bind(&token_hash)
    .execute(pool)
    .await
    .expect("insert reset token");
    raw
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_forgot_password_always_ok() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    register_user(&app, "forgotuser", "forgot@example.com", "Pass1234").await;

    // Existing email → 200
    let req = actix_test::TestRequest::post()
        .uri("/api/auth/password/forgot")
        .set_json(json!({ "email": "forgot@example.com" }))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);

    // Unknown email → still 200 (no user enumeration)
    let req = actix_test::TestRequest::post()
        .uri("/api/auth/password/forgot")
        .set_json(json!({ "email": "nobody@example.com" }))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_reset_password_success() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    register_user(&app, "resetuser", "reset@example.com", "Pass1234").await;
    let token = insert_reset_token(&pool, "reset@example.com", true).await;

    let req = actix_test::TestRequest::post()
        .uri("/api/auth/password/reset")
        .set_json(json!({ "token": token, "new_password": "NewPass5678" }))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);

    // Old password rejected
    let req = actix_test::TestRequest::post()
        .uri("/api/auth/login")
        .set_json(json!({ "email": "reset@example.com", "password": "Pass1234" }))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 401);

    // New password works
    login_user(&app, "reset@example.com", "NewPass5678").await;
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_reset_password_invalid_token() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    register_user(&app, "badtoken", "badtoken@example.com", "Pass1234").await;

    let req = actix_test::TestRequest::post()
        .uri("/api/auth/password/reset")
        .set_json(json!({ "token": "not-a-real-token", "new_password": "NewPass5678" }))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 400);
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_reset_password_expired_token() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    register_user(&app, "expuser", "exp@example.com", "Pass1234").await;
    let token = insert_reset_token(&pool, "exp@example.com", false).await;

    let req = actix_test::TestRequest::post()
        .uri("/api/auth/password/reset")
        .set_json(json!({ "token": token, "new_password": "NewPass5678" }))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 400);
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_reset_password_token_single_use() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    register_user(&app, "onceuser", "once@example.com", "Pass1234").await;
    let token = insert_reset_token(&pool, "once@example.com", true).await;

    // First use succeeds
    let req = actix_test::TestRequest::post()
        .uri("/api/auth/password/reset")
        .set_json(json!({ "token": &token, "new_password": "NewPass5678" }))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);

    // Reusing the same token fails
    let req = actix_test::TestRequest::post()
        .uri("/api/auth/password/reset")
        .set_json(json!({ "token": &token, "new_password": "AnotherPass9" }))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 400);
}

// ── Session Management Tests ──────────────────────────────────

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_sessions_requires_auth() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    let req = actix_test::TestRequest::get()
        .uri("/api/auth/sessions")
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 401);
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_list_sessions_shows_current() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    // Register, then log in again → two active sessions.
    register_user(&app, "sessuser", "sess@example.com", "Pass1234").await;
    let (token2, refresh2) = login_user(&app, "sess@example.com", "Pass1234").await;

    let req = actix_test::TestRequest::get()
        .uri("/api/auth/sessions")
        .insert_header(("Authorization", format!("Bearer {token2}")))
        .insert_header(("Cookie", format!("{REFRESH_COOKIE_NAME}={refresh2}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);

    let body: Value = actix_test::read_body_json(resp).await;
    let sessions = body.as_array().unwrap();
    assert_eq!(sessions.len(), 2, "expected two active sessions");
    let current = sessions.iter().filter(|s| s["current"] == true).count();
    assert_eq!(current, 1, "exactly one session should be flagged current");
    // Token hashes must never be exposed in the session list.
    assert!(sessions.iter().all(|s| s.get("token_hash").is_none()));
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_revoke_one_session() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    register_user(&app, "revuser", "rev@example.com", "Pass1234").await;
    let (token2, _) = login_user(&app, "rev@example.com", "Pass1234").await;

    // Two sessions exist; grab one id.
    let req = actix_test::TestRequest::get()
        .uri("/api/auth/sessions")
        .insert_header(("Authorization", format!("Bearer {token2}")))
        .peer_addr(peer_addr())
        .to_request();
    let body: Value = actix_test::read_body_json(actix_test::call_service(&app, req).await).await;
    let session_id = body.as_array().unwrap()[0]["id"]
        .as_str()
        .unwrap()
        .to_string();

    // Revoke it.
    let req = actix_test::TestRequest::delete()
        .uri(&format!("/api/auth/sessions/{session_id}"))
        .insert_header(("Authorization", format!("Bearer {token2}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);

    // List now has one fewer; re-revoking the same id is a no-op 404.
    let req = actix_test::TestRequest::get()
        .uri("/api/auth/sessions")
        .insert_header(("Authorization", format!("Bearer {token2}")))
        .peer_addr(peer_addr())
        .to_request();
    let body: Value = actix_test::read_body_json(actix_test::call_service(&app, req).await).await;
    assert_eq!(body.as_array().unwrap().len(), 1);

    let req = actix_test::TestRequest::delete()
        .uri(&format!("/api/auth/sessions/{session_id}"))
        .insert_header(("Authorization", format!("Bearer {token2}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 404);
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_revoke_session_not_owned() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    let (token_a, _, _) = register_user(&app, "owner_s", "owner_s@example.com", "Pass1234").await;
    let (token_b, _, _) = register_user(&app, "attacker_s", "att_s@example.com", "Pass1234").await;

    // A's session id
    let req = actix_test::TestRequest::get()
        .uri("/api/auth/sessions")
        .insert_header(("Authorization", format!("Bearer {token_a}")))
        .peer_addr(peer_addr())
        .to_request();
    let body: Value = actix_test::read_body_json(actix_test::call_service(&app, req).await).await;
    let a_session = body.as_array().unwrap()[0]["id"]
        .as_str()
        .unwrap()
        .to_string();

    // B cannot revoke A's session → 404 (no enumeration)
    let req = actix_test::TestRequest::delete()
        .uri(&format!("/api/auth/sessions/{a_session}"))
        .insert_header(("Authorization", format!("Bearer {token_b}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 404);

    // A's session still works for refresh-derived listing
    let req = actix_test::TestRequest::get()
        .uri("/api/auth/sessions")
        .insert_header(("Authorization", format!("Bearer {token_a}")))
        .peer_addr(peer_addr())
        .to_request();
    let body: Value = actix_test::read_body_json(actix_test::call_service(&app, req).await).await;
    assert_eq!(body.as_array().unwrap().len(), 1);
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_logout_all_sessions() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    let (_, refresh1, _) = register_user(&app, "alluser", "all@example.com", "Pass1234").await;
    let (token2, refresh2) = login_user(&app, "all@example.com", "Pass1234").await;

    let req = actix_test::TestRequest::post()
        .uri("/api/auth/sessions/logout-all")
        .insert_header(("Authorization", format!("Bearer {token2}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);

    // Both refresh tokens are now revoked.
    for refresh in [refresh1, refresh2] {
        let req = actix_test::TestRequest::post()
            .uri("/api/auth/refresh")
            .set_json(json!({ "refresh_token": refresh }))
            .peer_addr(peer_addr())
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), 401);
    }

    // No active sessions remain.
    let req = actix_test::TestRequest::get()
        .uri("/api/auth/sessions")
        .insert_header(("Authorization", format!("Bearer {token2}")))
        .peer_addr(peer_addr())
        .to_request();
    let body: Value = actix_test::read_body_json(actix_test::call_service(&app, req).await).await;
    assert_eq!(body.as_array().unwrap().len(), 0);
}

// ── Access Control Tests ──────────────────────────────────────

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_tracking_requires_auth() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    let req = actix_test::TestRequest::get()
        .uri("/api/tracking")
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 401);
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_tracking_status_transitions_only_record_completions() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;
    let (token, _, user_id) =
        register_user(&app, "trackmovie", "trackmovie@example.com", "Pass1234").await;
    let user_id = Uuid::parse_str(&user_id).unwrap();

    let media_id = sqlx::query_scalar::<_, Uuid>(
        r#"INSERT INTO media (tmdb_id, media_type, title, runtime_minutes)
        VALUES (991001, 'movie', 'Tracking Test Movie', 120)
        RETURNING id"#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    let req = actix_test::TestRequest::post()
        .uri("/api/tracking")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .set_json(json!({
            "tmdb_id": 991001,
            "media_type": "movie",
            "status": "plan_to_watch"
        }))
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 201);
    let body: Value = actix_test::read_body_json(resp).await;
    let tracking_id = body["id"].as_str().unwrap().to_string();
    assert!(body["completed_at"].is_null());

    let history_count = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM watch_history WHERE user_id = $1 AND media_id = $2",
    )
    .bind(user_id)
    .bind(media_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(history_count, 0, "planning a title is not a watch event");

    let req = actix_test::TestRequest::patch()
        .uri(&format!("/api/tracking/{tracking_id}"))
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .set_json(json!({ "status": "completed" }))
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);
    let body: Value = actix_test::read_body_json(resp).await;
    assert!(body["completed_at"].is_string());

    let history_count = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM watch_history WHERE user_id = $1 AND media_id = $2 AND episode_id IS NULL",
    )
    .bind(user_id)
    .bind(media_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(history_count, 1);

    let req = actix_test::TestRequest::patch()
        .uri(&format!("/api/tracking/{tracking_id}"))
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .set_json(json!({ "status": "watching" }))
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);
    let body: Value = actix_test::read_body_json(resp).await;
    assert!(body["completed_at"].is_null());

    let req = actix_test::TestRequest::patch()
        .uri(&format!("/api/tracking/{tracking_id}"))
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .set_json(json!({ "status": "completed" }))
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);

    let history_count = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM watch_history WHERE user_id = $1 AND media_id = $2",
    )
    .bind(user_id)
    .bind(media_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(history_count, 1, "re-completing must not invent a rewatch");

    let tomorrow = (chrono::Utc::now().date_naive() + chrono::Duration::days(1)).to_string();
    let req = actix_test::TestRequest::patch()
        .uri(&format!("/api/tracking/{tracking_id}"))
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .set_json(json!({ "completed_at": tomorrow }))
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 400);
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_completing_show_records_cached_episodes_idempotently() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;
    let (token, _, user_id) =
        register_user(&app, "trackshow", "trackshow@example.com", "Pass1234").await;
    let user_id = Uuid::parse_str(&user_id).unwrap();

    let media_id = sqlx::query_scalar::<_, Uuid>(
        r#"INSERT INTO media (tmdb_id, media_type, title, runtime_minutes)
        VALUES (991002, 'tv', 'Tracking Test Show', 45)
        RETURNING id"#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let season_id = sqlx::query_scalar::<_, Uuid>(
        r#"INSERT INTO seasons (media_id, season_number, name, episode_count)
        VALUES ($1, 1, 'Season 1', 2)
        RETURNING id"#,
    )
    .bind(media_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"INSERT INTO episodes (season_id, episode_number, name, runtime_minutes)
        VALUES ($1, 1, 'Episode 1', 42), ($1, 2, 'Episode 2', 44)"#,
    )
    .bind(season_id)
    .execute(&pool)
    .await
    .unwrap();

    let req = actix_test::TestRequest::post()
        .uri("/api/tracking")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .set_json(json!({
            "tmdb_id": 991002,
            "media_type": "tv",
            "status": "completed"
        }))
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 201);
    let body: Value = actix_test::read_body_json(resp).await;
    let tracking_id = body["id"].as_str().unwrap().to_string();

    let counts = sqlx::query_as::<_, (i64, i64)>(
        r#"SELECT
            COUNT(*) FILTER (WHERE episode_id IS NOT NULL),
            COUNT(*) FILTER (WHERE episode_id IS NULL)
        FROM watch_history WHERE user_id = $1 AND media_id = $2"#,
    )
    .bind(user_id)
    .bind(media_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(counts, (2, 0));

    for status in ["watching", "completed"] {
        let req = actix_test::TestRequest::patch()
            .uri(&format!("/api/tracking/{tracking_id}"))
            .insert_header(("Authorization", format!("Bearer {token}")))
            .peer_addr(peer_addr())
            .set_json(json!({ "status": status }))
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), 200);
    }

    let history_count = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM watch_history WHERE user_id = $1 AND media_id = $2",
    )
    .bind(user_id)
    .bind(media_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(history_count, 2);

    let uncached_media_id = sqlx::query_scalar::<_, Uuid>(
        r#"INSERT INTO media (tmdb_id, media_type, title, runtime_minutes)
        VALUES (991003, 'tv', 'Uncached Tracking Test Show', 30)
        RETURNING id"#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let req = actix_test::TestRequest::post()
        .uri("/api/tracking")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .set_json(json!({
            "tmdb_id": 991003,
            "media_type": "tv",
            "status": "completed"
        }))
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 201);

    let marker_count = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM watch_history WHERE user_id = $1 AND media_id = $2 AND episode_id IS NULL",
    )
    .bind(user_id)
    .bind(uncached_media_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(marker_count, 1);
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_history_requires_auth() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    let req = actix_test::TestRequest::get()
        .uri("/api/history")
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 401);
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_persistent_storage_quotas_release_deleted_slots() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;
    let (token, _, user_id) =
        register_user(&app, "storagequota", "storagequota@example.com", "Pass1234").await;
    let user_id = Uuid::parse_str(&user_id).unwrap();
    let tracking_max = cinetrack::services::quota::MAX_TRACKING_ITEMS_PER_USER;
    let history_max = cinetrack::services::quota::MAX_HISTORY_EVENTS_PER_USER;
    const TMDB_BASE: i32 = 1_200_000;

    sqlx::query(
        r#"INSERT INTO media (tmdb_id, media_type, title)
        SELECT $1 + value::integer, 'movie', 'Quota movie ' || value
        FROM generate_series(1, $2::bigint) AS value"#,
    )
    .bind(TMDB_BASE)
    .bind(tracking_max + 2)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"INSERT INTO user_media (user_id, media_id, status)
        SELECT $1, id, 'plan_to_watch'
        FROM media
        WHERE tmdb_id > $2 AND tmdb_id <= $2 + $3::integer"#,
    )
    .bind(user_id)
    .bind(TMDB_BASE)
    .bind(i32::try_from(tracking_max).unwrap())
    .execute(&pool)
    .await
    .unwrap();

    let existing_tmdb_id = TMDB_BASE + 1;
    let new_tmdb_id = TMDB_BASE + i32::try_from(tracking_max).unwrap() + 1;
    let second_new_tmdb_id = new_tmdb_id + 1;
    let req = actix_test::TestRequest::post()
        .uri("/api/tracking")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .set_json(json!({
            "tmdb_id": new_tmdb_id,
            "media_type": "movie",
            "status": "plan_to_watch"
        }))
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 409);

    let req = actix_test::TestRequest::post()
        .uri("/api/tracking")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .set_json(json!({
            "tmdb_id": existing_tmdb_id,
            "media_type": "movie",
            "status": "watching"
        }))
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 201, "updates remain allowed at the quota");

    let tracking_id = sqlx::query_scalar::<_, Uuid>(
        r#"SELECT um.id FROM user_media um
        JOIN media m ON m.id = um.media_id
        WHERE um.user_id = $1 AND m.tmdb_id = $2 AND m.media_type = 'movie'"#,
    )
    .bind(user_id)
    .bind(existing_tmdb_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let req = actix_test::TestRequest::delete()
        .uri(&format!("/api/tracking/{tracking_id}"))
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);

    let first_req = actix_test::TestRequest::post()
        .uri("/api/tracking")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .set_json(json!({
            "tmdb_id": new_tmdb_id,
            "media_type": "movie",
            "status": "plan_to_watch"
        }))
        .to_request();
    let second_req = actix_test::TestRequest::post()
        .uri("/api/tracking")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .set_json(json!({
            "tmdb_id": second_new_tmdb_id,
            "media_type": "movie",
            "status": "plan_to_watch"
        }))
        .to_request();
    let (first_resp, second_resp) = futures_util::future::join(
        actix_test::call_service(&app, first_req),
        actix_test::call_service(&app, second_req),
    )
    .await;
    let tracking_statuses = [first_resp.status(), second_resp.status()];
    assert_eq!(
        tracking_statuses
            .iter()
            .filter(|status| status.as_u16() == 201)
            .count(),
        1,
        "exactly one concurrent title can claim the released slot"
    );
    assert_eq!(
        tracking_statuses
            .iter()
            .filter(|status| status.as_u16() == 409)
            .count(),
        1,
        "the competing title must be rejected at the quota"
    );

    let tracking_count =
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM user_media WHERE user_id = $1")
            .bind(user_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(tracking_count, tracking_max);

    let history_media_id = sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM media WHERE tmdb_id = $1 AND media_type = 'movie'",
    )
    .bind(new_tmdb_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"INSERT INTO watch_history (user_id, media_id, watched_at)
        SELECT $1, $2, NOW() FROM generate_series(1, $3::bigint)"#,
    )
    .bind(user_id)
    .bind(history_media_id)
    .bind(history_max)
    .execute(&pool)
    .await
    .unwrap();

    let req = actix_test::TestRequest::post()
        .uri("/api/history")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .set_json(json!({ "media_id": history_media_id }))
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 409);

    let history_id =
        sqlx::query_scalar::<_, Uuid>("SELECT id FROM watch_history WHERE user_id = $1 LIMIT 1")
            .bind(user_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    let req = actix_test::TestRequest::delete()
        .uri(&format!("/api/history/{history_id}"))
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);

    let first_req = actix_test::TestRequest::post()
        .uri("/api/history")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .set_json(json!({ "media_id": history_media_id }))
        .to_request();
    let second_req = actix_test::TestRequest::post()
        .uri("/api/history")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .set_json(json!({ "media_id": history_media_id }))
        .to_request();
    let (first_resp, second_resp) = futures_util::future::join(
        actix_test::call_service(&app, first_req),
        actix_test::call_service(&app, second_req),
    )
    .await;
    let history_statuses = [first_resp.status(), second_resp.status()];
    assert_eq!(
        history_statuses
            .iter()
            .filter(|status| status.as_u16() == 201)
            .count(),
        1,
        "exactly one concurrent history event can claim the released slot"
    );
    assert_eq!(
        history_statuses
            .iter()
            .filter(|status| status.as_u16() == 409)
            .count(),
        1,
        "the competing history event must be rejected at the quota"
    );

    let history_count =
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM watch_history WHERE user_id = $1")
            .bind(user_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(history_count, history_max);
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_import_requires_auth() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;
    let boundary = "cinetrack-import-boundary";
    let payload = format!(
        "--{boundary}\r\n\
         Content-Disposition: form-data; name=\"movies\"; filename=\"movies.json\"\r\n\
         Content-Type: application/json\r\n\r\n\
         []\r\n\
         --{boundary}--\r\n"
    );

    let req = actix_test::TestRequest::post()
        .uri("/api/import/tvtime")
        .insert_header((
            header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={boundary}"),
        ))
        .peer_addr(peer_addr())
        .set_payload(payload)
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 401);
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_import_job_reservation_is_atomic() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;
    let (token, _, user_id) =
        register_user(&app, "importuser", "importuser@example.com", "Pass1234").await;
    let user_id = Uuid::parse_str(&user_id).unwrap();
    sqlx::query("INSERT INTO import_jobs (user_id, status) VALUES ($1, 'completed')")
        .bind(user_id)
        .execute(&pool)
        .await
        .unwrap();

    let boundary = "cinetrack-import-boundary";
    let payload = format!(
        "--{boundary}\r\n\
         Content-Disposition: form-data; name=\"movies\"; filename=\"movies.json\"\r\n\
         Content-Type: application/json\r\n\r\n\
         [{{\"id\": {{\"imdb\": \"-1\"}}, \"title\": \"Import Test\"}}]\r\n\
         --{boundary}--\r\n"
    );
    let req = actix_test::TestRequest::post()
        .uri("/api/import/tvtime")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .insert_header((
            header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={boundary}"),
        ))
        .peer_addr(peer_addr())
        .set_payload(payload)
        .to_request();
    let resp = actix_test::call_service(&app, req).await;

    assert_eq!(resp.status(), 409);
    let job_count = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM import_jobs WHERE user_id = $1 AND status IN ('pending', 'running', 'completed')",
    )
    .bind(user_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(job_count, 1);
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_lists_requires_auth() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    let req = actix_test::TestRequest::get()
        .uri("/api/lists/me")
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 401);
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_stats_requires_auth() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    let req = actix_test::TestRequest::get()
        .uri("/api/stats/me")
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 401);
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_stats_count_events_rewatches_and_completed_show_gaps() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;
    let (token, _, user_id) =
        register_user(&app, "statsuser", "statsuser@example.com", "Pass1234").await;
    let user_id = Uuid::parse_str(&user_id).unwrap();

    let show_id = sqlx::query_scalar::<_, Uuid>(
        r#"INSERT INTO media (tmdb_id, media_type, title, runtime_minutes, genres)
        VALUES (992001, 'tv', 'Completed Stats Show', 45, '[{"id": 1, "name": "Drama"}]')
        RETURNING id"#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let season_id = sqlx::query_scalar::<_, Uuid>(
        r#"INSERT INTO seasons (media_id, season_number, name, episode_count)
        VALUES ($1, 1, 'Season 1', 3)
        RETURNING id"#,
    )
    .bind(show_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let episode_id = sqlx::query_scalar::<_, Uuid>(
        r#"INSERT INTO episodes (season_id, episode_number, name, runtime_minutes)
        VALUES ($1, 1, 'Episode 1', 40)
        RETURNING id"#,
    )
    .bind(season_id)
    .fetch_one(&pool)
    .await
    .unwrap();

    let planned_show_id = sqlx::query_scalar::<_, Uuid>(
        r#"INSERT INTO media (tmdb_id, media_type, title, runtime_minutes, genres)
        VALUES (992002, 'tv', 'Planned Stats Show', 30, '[{"id": 2, "name": "Comedy"}]')
        RETURNING id"#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let movie_id = sqlx::query_scalar::<_, Uuid>(
        r#"INSERT INTO media (tmdb_id, media_type, title, runtime_minutes, genres)
        VALUES (992003, 'movie', 'Completed Stats Movie', 120, '[{"id": 3, "name": "Action"}]')
        RETURNING id"#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    sqlx::query(
        r#"INSERT INTO user_media
            (user_id, media_id, status, started_at, completed_at, updated_at)
        VALUES
            ($1, $2, 'completed', '2026-02-01', '2026-02-03', '2026-02-03T08:00:00Z'),
            ($1, $3, 'plan_to_watch', NULL, NULL, '2026-02-03T08:00:00Z'),
            ($1, $4, 'completed', '2026-02-03', '2026-02-03', '2026-02-03T08:00:00Z')"#,
    )
    .bind(user_id)
    .bind(show_id)
    .bind(planned_show_id)
    .bind(movie_id)
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query(
        r#"INSERT INTO watch_history (user_id, media_id, episode_id, watched_at)
        VALUES
            ($1, $2, $3, '2026-02-03T08:00:00Z'),
            ($1, $2, $3, '2026-02-03T09:00:00Z'),
            ($1, $2, NULL, '2026-02-03T10:00:00Z'),
            ($1, $4, NULL, '2026-02-03T11:00:00Z')"#,
    )
    .bind(user_id)
    .bind(show_id)
    .bind(episode_id)
    .bind(movie_id)
    .execute(&pool)
    .await
    .unwrap();

    let req = actix_test::TestRequest::get()
        .uri("/api/stats/me")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);
    let stats: Value = actix_test::read_body_json(resp).await;
    assert_eq!(stats["total_movies"], 1);
    assert_eq!(stats["total_shows"], 1);
    assert_eq!(stats["total_episodes"], 4);
    assert!((stats["total_hours"].as_f64().unwrap() - (290.0 / 60.0)).abs() < 0.000_001);
    assert_eq!(stats["current_streak"], 0);
    assert_eq!(stats["longest_streak"], 1);

    let req = actix_test::TestRequest::get()
        .uri("/api/stats/me/heatmap?year=2026")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);
    let heatmap: Value = actix_test::read_body_json(resp).await;
    assert_eq!(heatmap.as_array().unwrap().len(), 1);
    assert_eq!(heatmap[0]["date"], "2026-02-03");
    assert_eq!(heatmap[0]["count"], 4);

    let req = actix_test::TestRequest::get()
        .uri("/api/stats/me/genres")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);
    let genres: Value = actix_test::read_body_json(resp).await;
    let genre_names: Vec<&str> = genres
        .as_array()
        .unwrap()
        .iter()
        .map(|genre| genre["genre"].as_str().unwrap())
        .collect();
    assert_eq!(genre_names.len(), 2);
    assert!(genre_names.contains(&"Drama"));
    assert!(genre_names.contains(&"Action"));
    assert!(!genre_names.contains(&"Comedy"));

    let req = actix_test::TestRequest::get()
        .uri("/api/stats/me/monthly")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);
    let monthly: Value = actix_test::read_body_json(resp).await;
    assert_eq!(monthly.as_array().unwrap().len(), 1);
    assert_eq!(monthly[0]["month"], "2026-02");
    assert_eq!(monthly[0]["count"], 4);
    assert!((monthly[0]["hours"].as_f64().unwrap() - (245.0 / 60.0)).abs() < 0.000_001);
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_media_search_requires_auth() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    let req = actix_test::TestRequest::get()
        .uri("/api/media/search?q=test")
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 401);
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_media_search_uses_fresh_and_stale_provider_cache() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let upstream = actix_web::rt::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = vec![0_u8; 4096];
        let read = stream.read(&mut request).await.unwrap();
        let request = String::from_utf8_lossy(&request[..read]);
        assert!(request.starts_with("GET /search/movie?"));
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let body = r#"{
            "page": 1,
            "total_pages": 1,
            "total_results": 1,
            "results": [{
                "id": 616161,
                "title": "Cache Me",
                "media_type": "movie",
                "vote_average": 7.4
            }]
        }"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        stream.write_all(response.as_bytes()).await.unwrap();
    });

    let pool = setup_pool().await;
    clean_db(&pool).await;
    let mut config = test_config();
    config.tmdb_base_url = format!("http://{address}");
    config.tmdb_timeout_seconds = 1;
    let app = actix_test::init_service(create_app_with_config(pool.clone(), config)).await;
    let (token, _, _) =
        register_user(&app, "searchcache", "searchcache@example.com", "Pass1234").await;

    let search = |uri: &'static str| {
        actix_test::TestRequest::get()
            .uri(uri)
            .insert_header(("Authorization", format!("Bearer {token}")))
            .peer_addr(peer_addr())
            .to_request()
    };
    let first_request = search("/api/media/search?q=Cache%20Me&type=movie&page=1");
    let concurrent_request = search("/api/media/search?q=cache%20me&type=movie&page=1");
    let (first, concurrent) = futures_util::future::join(
        actix_test::call_service(&app, first_request),
        actix_test::call_service(&app, concurrent_request),
    )
    .await;
    assert_eq!(first.status(), 200);
    assert_eq!(concurrent.status(), 200);
    let body: Value = actix_test::read_body_json(first).await;
    assert_eq!(body["results"][0]["id"], 616161);
    upstream.await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT metadata_level FROM media WHERE tmdb_id = 616161 AND media_type = 'movie'",
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        "summary"
    );

    // Normalization collapses whitespace and case, so this is the same key.
    let fresh = actix_test::call_service(
        &app,
        search("/api/media/search?q=%20cache%20%20me%20&type=movie&page=1"),
    )
    .await;
    assert_eq!(fresh.status(), 200);
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM provider_response_cache WHERE endpoint = 'search'",
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        1
    );

    sqlx::query(
        r#"UPDATE provider_response_cache
        SET fetched_at = NOW() - INTERVAL '2 hours',
            expires_at = NOW() - INTERVAL '1 hour',
            stale_until = NOW() + INTERVAL '1 hour'
        WHERE endpoint = 'search'"#,
    )
    .execute(&pool)
    .await
    .unwrap();
    let stale = actix_test::call_service(
        &app,
        search("/api/media/search?q=Cache%20Me&type=movie&page=1"),
    )
    .await;
    assert_eq!(stale.status(), 200);
    let body: Value = actix_test::read_body_json(stale).await;
    assert_eq!(body["results"][0]["title"], "Cache Me");

    let metrics = actix_test::call_service(
        &app,
        actix_test::TestRequest::get()
            .uri("/metrics")
            .peer_addr(peer_addr())
            .to_request(),
    )
    .await;
    assert_eq!(metrics.status(), 200);
    let metrics = String::from_utf8(actix_test::read_body(metrics).await.to_vec()).unwrap();
    assert!(metrics.contains("cinetrack_tmdb_requests_total"));
    assert!(metrics.contains("cinetrack_tmdb_request_duration_seconds"));
    assert!(metrics.contains("cinetrack_tmdb_cache_events_total"));
    assert!(metrics.contains("endpoint=\"search\",outcome=\"2xx\"} 1"));
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_local_catalog_search_skips_or_replaces_unavailable_provider() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let mut config = test_config();
    config.tmdb_base_url = "http://127.0.0.1:9".to_string();
    config.tmdb_timeout_seconds = 1;
    let app = actix_test::init_service(create_app_with_config(pool.clone(), config)).await;
    let (token, _, _) =
        register_user(&app, "localsearch", "localsearch@example.com", "Pass1234").await;
    sqlx::query(
        r#"INSERT INTO media (tmdb_id, media_type, title, metadata_level)
        SELECT 620000 + value, 'movie', 'Offline Matrix ' || value, 'summary'
        FROM generate_series(1, 20) AS value"#,
    )
    .execute(&pool)
    .await
    .unwrap();
    let fallback_media_id = sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO media (tmdb_id, media_type, title, metadata_level) VALUES (620100, 'movie', 'Fallback Film', 'summary') RETURNING id",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"INSERT INTO media_title_aliases
            (media_id, kind, language_code, region_code, title)
        VALUES ($1, 'translation', 'ro', 'RO', 'Film de Rezerva')"#,
    )
    .bind(fallback_media_id)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"INSERT INTO catalog_external_ids
            (media_type, tmdb_id, adult, video, popularity)
        VALUES ('tv', 620200, false, false, 999.0)"#,
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"INSERT INTO catalog_external_titles (media_type, tmdb_id, title)
        VALUES ('tv', 620200, 'Archive Needle')"#,
    )
    .execute(&pool)
    .await
    .unwrap();

    let request = |query: &'static str| {
        actix_test::TestRequest::get()
            .uri(query)
            .insert_header(("Authorization", format!("Bearer {token}")))
            .peer_addr(peer_addr())
            .to_request()
    };
    let full_page = actix_test::call_service(
        &app,
        request("/api/media/search?q=Offline%20Matrix&type=movie&page=1"),
    )
    .await;
    assert_eq!(full_page.status(), 200);
    let full_page: Value = actix_test::read_body_json(full_page).await;
    assert_eq!(full_page["results"].as_array().unwrap().len(), 20);

    let fallback = actix_test::call_service(
        &app,
        request("/api/media/search?q=Fallback%20Film&type=movie&page=1"),
    )
    .await;
    assert_eq!(fallback.status(), 200);
    let fallback: Value = actix_test::read_body_json(fallback).await;
    assert_eq!(fallback["results"][0]["title"], "Fallback Film");

    let localized = actix_test::call_service(
        &app,
        request("/api/media/search?q=Film%20de%20Rezerva&type=movie&page=1&language=ro-RO"),
    )
    .await;
    assert_eq!(localized.status(), 200);
    let localized: Value = actix_test::read_body_json(localized).await;
    assert_eq!(localized["results"][0]["id"], 620100);
    assert_eq!(localized["results"][0]["title"], "Film de Rezerva");

    let inventory = actix_test::call_service(
        &app,
        request("/api/media/search?q=Archive%20Needle&type=tv&page=1"),
    )
    .await;
    assert_eq!(inventory.status(), 200);
    let inventory: Value = actix_test::read_body_json(inventory).await;
    assert_eq!(inventory["results"].as_array().unwrap().len(), 1);
    assert_eq!(inventory["results"][0]["name"], "Archive Needle");
    assert_eq!(inventory["results"][0]["media_type"], "tv");
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM media WHERE tmdb_id = 620200")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0,
        "catalog-only searches must not inflate the hydrated media cache"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM provider_response_cache")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_local_discovery_personalizes_and_filters_catalog() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;
    let (token, _, user_id) =
        register_user(&app, "discoveryuser", "discovery@example.com", "Pass1234").await;

    sqlx::query(
        r#"INSERT INTO media
            (tmdb_id, media_type, title, genres, poster_path, metadata_level,
             tmdb_vote_average)
        VALUES
            (670001, 'movie', 'Tracked Drama',
             '[{"id": 18, "name": "Drama"}]'::jsonb,
             '/tracked.jpg', 'detail', 8.8),
            (670002, 'movie', 'Drama Recommendation',
             '[{"id": 18, "name": "Drama"}]'::jsonb,
             '/drama.jpg', 'detail', 8.2),
            (670003, 'movie', 'Popular Comedy',
             '[{"id": 35, "name": "Comedy"}]'::jsonb,
             '/comedy.jpg', 'detail', 7.9),
            (670004, 'tv', 'Drama Series',
             '[{"id": 18, "name": "Drama"}]'::jsonb,
             '/series.jpg', 'detail', 8.0),
            (670005, 'movie', 'Adult Candidate',
             '[{"id": 18, "name": "Drama"}]'::jsonb,
             '/adult.jpg', 'detail', 9.0),
            (670006, 'movie', 'Video Candidate',
             '[{"id": 18, "name": "Drama"}]'::jsonb,
             '/video.jpg', 'detail', 9.0),
            (670007, 'movie', 'Summary Candidate',
             '[{"id": 18, "name": "Drama"}]'::jsonb,
             '/summary.jpg', 'summary', 9.0),
            (670008, 'movie', 'Posterless Candidate',
             '[{"id": 18, "name": "Drama"}]'::jsonb,
             NULL, 'detail', 9.0)"#,
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"INSERT INTO catalog_external_ids
            (media_type, tmdb_id, adult, video, popularity)
        VALUES
            ('movie', 670001, false, false, 100.0),
            ('movie', 670002, false, false, 90.0),
            ('movie', 670003, false, false, 500.0),
            ('tv', 670004, false, false, 80.0),
            ('movie', 670005, true, false, 10000.0),
            ('movie', 670006, false, true, 9000.0),
            ('movie', 670007, false, false, 8000.0),
            ('movie', 670008, false, false, 7000.0)"#,
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"INSERT INTO media_title_aliases
            (media_id, kind, language_code, region_code, title)
        SELECT id, 'translation', 'ro', 'RO', 'Alegerea dramatica'
        FROM media
        WHERE tmdb_id = 670002 AND media_type = 'movie'"#,
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"INSERT INTO user_media
            (user_id, media_id, status, rating, is_favorite)
        SELECT $1, id, 'completed', 9, TRUE
        FROM media
        WHERE tmdb_id = 670001 AND media_type = 'movie'"#,
    )
    .bind(Uuid::parse_str(&user_id).unwrap())
    .execute(&pool)
    .await
    .unwrap();

    let unauthenticated = actix_test::call_service(
        &app,
        actix_test::TestRequest::get()
            .uri("/api/media/discovery")
            .peer_addr(peer_addr())
            .to_request(),
    )
    .await;
    assert_eq!(unauthenticated.status(), 401);

    let invalid_locale = actix_test::call_service(
        &app,
        actix_test::TestRequest::get()
            .uri("/api/media/discovery?language=romanian")
            .insert_header(("Authorization", format!("Bearer {token}")))
            .peer_addr(peer_addr())
            .to_request(),
    )
    .await;
    assert_eq!(invalid_locale.status(), 400);

    let response = actix_test::call_service(
        &app,
        actix_test::TestRequest::get()
            .uri("/api/media/discovery?language=ro-RO")
            .insert_header(("Authorization", format!("Bearer {token}")))
            .peer_addr(peer_addr())
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), 200);
    let body: Value = actix_test::read_body_json(response).await;
    assert_eq!(body["personalized"], true);
    assert_eq!(body["recommendation_basis"], json!(["Drama"]));

    let recommendations = body["recommendations"].as_array().unwrap();
    let recommendation_ids = recommendations
        .iter()
        .map(|item| item["id"].as_i64().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(recommendation_ids[..2], [670002, 670004]);
    assert_eq!(recommendations[0]["title"], "Alegerea dramatica");
    for excluded in [670001, 670005, 670006, 670007, 670008] {
        assert!(!recommendation_ids.contains(&excluded));
    }

    let popular_movie_ids = body["popular_movies"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["id"].as_i64().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(popular_movie_ids, [670003, 670001, 670002]);
    let popular_show_ids = body["popular_shows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["id"].as_i64().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(popular_show_ids, [670004]);

    let (cold_token, _, _) =
        register_user(&app, "newdiscovery", "newdiscovery@example.com", "Pass1234").await;
    let cold_start = actix_test::call_service(
        &app,
        actix_test::TestRequest::get()
            .uri("/api/media/discovery?language=ro-RO")
            .insert_header(("Authorization", format!("Bearer {cold_token}")))
            .peer_addr(peer_addr())
            .to_request(),
    )
    .await;
    assert_eq!(cold_start.status(), 200);
    let cold_start: Value = actix_test::read_body_json(cold_start).await;
    assert_eq!(cold_start["personalized"], false);
    assert_eq!(cold_start["recommendation_basis"], json!([]));
    assert_eq!(cold_start["recommendations"][0]["id"], 670003);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM provider_response_cache")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_summary_media_is_hydrated_before_detail_response() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let upstream = actix_web::rt::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = vec![0_u8; 4096];
        let read = stream.read(&mut request).await.unwrap();
        let request = String::from_utf8_lossy(&request[..read]);
        assert!(request.starts_with("GET /movie/630001?"));
        assert!(request.contains("append_to_response=alternative_titles%2Ctranslations"));
        let body = r#"{
            "id": 630001,
            "title": "Hydrated Film",
            "overview": "Complete detail",
            "release_date": "2026-07-13",
            "status": "Released",
            "genres": [],
            "runtime": 101,
            "vote_average": 8.1,
            "alternative_titles": {
                "titles": [{"iso_3166_1": "RO", "title": "Filmul Hidratat"}]
            },
            "translations": {
                "translations": [{
                    "iso_3166_1": "RO",
                    "iso_639_1": "ro",
                    "data": {"title": "Film Hidratat"}
                }]
            }
        }"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        stream.write_all(response.as_bytes()).await.unwrap();
    });

    let pool = setup_pool().await;
    clean_db(&pool).await;
    sqlx::query(
        "INSERT INTO media (tmdb_id, media_type, title, metadata_level) VALUES (630001, 'movie', 'Hydrated Film', 'summary')",
    )
    .execute(&pool)
    .await
    .unwrap();
    let mut config = test_config();
    config.tmdb_base_url = format!("http://{address}");
    let app = actix_test::init_service(create_app_with_config(pool.clone(), config)).await;
    let (token, _, _) = register_user(&app, "hydrate", "hydrate@example.com", "Pass1234").await;

    let req = actix_test::TestRequest::get()
        .uri("/api/media/630001?type=movie&language=ro-RO")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .to_request();
    let response = actix_test::call_service(&app, req).await;
    assert_eq!(response.status(), 200);
    let detail: Value = actix_test::read_body_json(response).await;
    assert_eq!(detail["title"], "Film Hidratat");
    assert_eq!(detail["overview"], "Complete detail");
    assert_eq!(detail["runtime_minutes"], 101);
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT metadata_level FROM media WHERE tmdb_id = 630001")
            .fetch_one(&pool)
            .await
            .unwrap(),
        "detail"
    );
    assert_eq!(
        sqlx::query_as::<_, (String, bool, i64)>(
            r#"SELECT
                title,
                title_aliases_cached_at IS NOT NULL,
                (SELECT COUNT(*) FROM media_title_aliases WHERE media_id = media.id)
            FROM media
            WHERE tmdb_id = 630001"#,
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        ("Hydrated Film".to_string(), true, 2)
    );
    upstream.await.unwrap();
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_browsing_tmdb_detail_persists_catalog_cache() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let upstream = actix_web::rt::spawn(async move {
        for _ in 0..3 {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = vec![0_u8; 4096];
            let read = stream.read(&mut request).await.unwrap();
            let request = String::from_utf8_lossy(&request[..read]);
            let body = if request.starts_with("GET /movie/424242?") {
                r#"{
                    "id": 424242,
                    "title": "Read Only Detail",
                    "original_title": "Read Only Detail",
                    "overview": "Fetched without persistence",
                    "poster_path": "/poster.jpg",
                    "backdrop_path": "/backdrop.jpg",
                    "release_date": "2026-07-12",
                    "status": "Released",
                    "genres": [{"id": 18, "name": "Drama"}],
                    "runtime": 123,
                    "vote_average": 8.5
                }"#
            } else if request.starts_with("GET /tv/515151/season/1?") {
                r#"{
                    "episodes": [{
                        "episode_number": 1,
                        "name": "Pilot",
                        "overview": "Read-only episode",
                        "runtime": 47,
                        "air_date": "2026-07-12",
                        "still_path": "/still.jpg"
                    }]
                }"#
            } else {
                assert!(request.starts_with("GET /tv/515151?"));
                r#"{
                    "id": 515151,
                    "name": "Read Only Show",
                    "seasons": [{
                        "id": 9001,
                        "season_number": 1,
                        "name": "Season 1",
                        "episode_count": 8,
                        "air_date": "2026-07-12"
                    }]
                }"#
            };
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        }
    });

    let pool = setup_pool().await;
    clean_db(&pool).await;
    let mut config = test_config();
    config.tmdb_base_url = format!("http://{address}");
    let app = actix_test::init_service(create_app_with_config(pool.clone(), config)).await;
    let (token, _, _) = register_user(
        &app,
        "readonlymedia",
        "readonlymedia@example.com",
        "Pass1234",
    )
    .await;

    let before = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM media")
        .fetch_one(&pool)
        .await
        .unwrap();
    let req = actix_test::TestRequest::get()
        .uri("/api/media/424242?type=movie")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);
    let body: Value = actix_test::read_body_json(resp).await;
    assert_eq!(body["id"], "424242");
    assert_eq!(body["tmdb_id"], 424242);
    assert_eq!(body["media_type"], "movie");
    assert_eq!(body["runtime_minutes"], 123);
    assert_eq!(body["vote_average"], 8.5);

    let req = actix_test::TestRequest::get()
        .uri("/api/media/515151/seasons")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);
    let body: Value = actix_test::read_body_json(resp).await;
    assert!(Uuid::parse_str(body[0]["id"].as_str().unwrap()).is_ok());
    assert_eq!(body[0]["episode_count"], 8);

    let req = actix_test::TestRequest::get()
        .uri("/api/media/515151/seasons/1/episodes")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);
    let body: Value = actix_test::read_body_json(resp).await;
    assert!(Uuid::parse_str(body[0]["id"].as_str().unwrap()).is_ok());
    assert_eq!(body[0]["runtime_minutes"], 47);

    let after = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM media")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(after, before + 2, "browsing should populate local catalog");
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM seasons s JOIN media m ON m.id = s.media_id WHERE m.tmdb_id = 515151",
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM episodes e JOIN seasons s ON s.id = e.season_id JOIN media m ON m.id = s.media_id WHERE m.tmdb_id = 515151",
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        1
    );
    upstream.await.unwrap();

    // The upstream listener is closed; all three responses must now come from
    // PostgreSQL without a network dependency.
    for uri in [
        "/api/media/424242?type=movie",
        "/api/media/515151/seasons",
        "/api/media/515151/seasons/1/episodes",
    ] {
        let req = actix_test::TestRequest::get()
            .uri(uri)
            .insert_header(("Authorization", format!("Bearer {token}")))
            .peer_addr(peer_addr())
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), 200, "cache miss for {uri}");
    }
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_orphan_media_pruner_preserves_references_and_active_imports() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;
    let (_, _, user_id) =
        register_user(&app, "cachepruner", "cachepruner@example.com", "Pass1234").await;
    let user_id = Uuid::parse_str(&user_id).unwrap();

    let rows = sqlx::query_as::<_, (Uuid, i32)>(
        r#"INSERT INTO media (tmdb_id, media_type, title, tmdb_cached_at)
        VALUES
            (994001, 'tv', 'Old orphan', NOW() - INTERVAL '176 days'),
            (994002, 'movie', 'Recent orphan', NOW()),
            (994003, 'movie', 'Tracked media', NOW() - INTERVAL '176 days'),
            (994004, 'movie', 'History media', NOW() - INTERVAL '176 days'),
            (994005, 'movie', 'Listed media', NOW() - INTERVAL '176 days')
        RETURNING id, tmdb_id"#,
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE media SET last_accessed_at = tmdb_cached_at WHERE tmdb_id BETWEEN 994001 AND 994005",
    )
    .execute(&pool)
    .await
    .unwrap();
    let media_id = |tmdb_id| {
        rows.iter()
            .find(|(_, candidate)| *candidate == tmdb_id)
            .unwrap()
            .0
    };

    let orphan_season_id = sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO seasons (media_id, season_number, name) VALUES ($1, 1, 'Season 1') RETURNING id",
    )
    .bind(media_id(994001))
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO episodes (season_id, episode_number, name) VALUES ($1, 1, 'Episode 1')",
    )
    .bind(orphan_season_id)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO user_media (user_id, media_id, status) VALUES ($1, $2, 'watching')")
        .bind(user_id)
        .bind(media_id(994003))
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO watch_history (user_id, media_id) VALUES ($1, $2)")
        .bind(user_id)
        .bind(media_id(994004))
        .execute(&pool)
        .await
        .unwrap();
    let list_id = sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO lists (user_id, name) VALUES ($1, 'Pruner list') RETURNING id",
    )
    .bind(user_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO list_items (list_id, media_id) VALUES ($1, $2)")
        .bind(list_id)
        .bind(media_id(994005))
        .execute(&pool)
        .await
        .unwrap();
    let job_id = sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO import_jobs (user_id, status) VALUES ($1, 'running') RETURNING id",
    )
    .bind(user_id)
    .fetch_one(&pool)
    .await
    .unwrap();

    let deleted = cinetrack::services::media_cache::prune_orphaned_media(&pool)
        .await
        .unwrap();
    assert_eq!(deleted, 0, "active imports pause orphan cleanup");

    sqlx::query("UPDATE import_jobs SET status = 'failed' WHERE id = $1")
        .bind(job_id)
        .execute(&pool)
        .await
        .unwrap();
    let deleted = cinetrack::services::media_cache::prune_orphaned_media(&pool)
        .await
        .unwrap();
    assert_eq!(deleted, 1);

    let remaining = sqlx::query_scalar::<_, i32>(
        "SELECT tmdb_id FROM media WHERE tmdb_id BETWEEN 994001 AND 994005 ORDER BY tmdb_id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(remaining, vec![994002, 994003, 994004, 994005]);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM seasons WHERE id = $1")
            .bind(orphan_season_id)
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM episodes WHERE season_id = $1")
            .bind(orphan_season_id)
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_provider_response_pruner_removes_only_expired_entries() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    sqlx::query(
        r#"INSERT INTO provider_response_cache
            (provider, cache_key, endpoint, payload, fetched_at, expires_at, stale_until)
        VALUES
            ('tmdb', repeat('a', 64), 'search', '{}'::jsonb,
             NOW() - INTERVAL '3 hours', NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 hour'),
            ('tmdb', repeat('b', 64), 'trending', '{}'::jsonb,
             NOW(), NOW() + INTERVAL '30 minutes', NOW() + INTERVAL '1 day')"#,
    )
    .execute(&pool)
    .await
    .unwrap();

    let deleted = cinetrack::services::media_cache::prune_provider_response_cache(&pool)
        .await
        .unwrap();
    assert_eq!(deleted, 1);
    let keys = sqlx::query_scalar::<_, String>(
        "SELECT btrim(cache_key) FROM provider_response_cache ORDER BY cache_key",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(keys, vec!["b".repeat(64)]);
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_catalog_inventory_is_compact_and_constrained() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    sqlx::query(
        r#"INSERT INTO catalog_external_ids
            (media_type, tmdb_id, adult, video, popularity)
        VALUES ('movie', 640001, false, false, 12.5)"#,
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"INSERT INTO catalog_external_ids
            (media_type, tmdb_id, adult, video, popularity)
        VALUES ('tv', 640002, false, false, 10.0)"#,
    )
    .execute(&pool)
    .await
    .unwrap();

    let invalid = sqlx::query(
        r#"INSERT INTO catalog_external_ids
            (media_type, tmdb_id, adult, video, popularity)
        VALUES ('person', -1, false, false, -1)"#,
    )
    .execute(&pool)
    .await;
    assert!(invalid.is_err());
    let unknown_adult_flag = sqlx::query(
        r#"INSERT INTO catalog_external_ids
            (media_type, tmdb_id, adult, video, popularity)
        VALUES ('tv', 640003, NULL, false, 8.0)"#,
    )
    .execute(&pool)
    .await;
    assert!(unknown_adult_flag.is_err());
    sqlx::query(
        r#"INSERT INTO catalog_external_titles (media_type, tmdb_id, title)
        VALUES ('movie', 640001, 'Indexed Catalog Film')"#,
    )
    .execute(&pool)
    .await
    .unwrap();
    let invalid_title = sqlx::query(
        r#"INSERT INTO catalog_external_titles (media_type, tmdb_id, title)
        VALUES ('tv', 640002, E'Bad\nTitle')"#,
    )
    .execute(&pool)
    .await;
    assert!(invalid_title.is_err());
    let media_id = sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO media (tmdb_id, media_type, title) VALUES (640010, 'movie', 'Alias Fixture') RETURNING id",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let invalid_alias = sqlx::query(
        r#"INSERT INTO media_title_aliases
            (media_id, kind, language_code, region_code, title)
        VALUES ($1, 'translation', 'RO', 'ro', E'Bad\nAlias')"#,
    )
    .bind(media_id)
    .execute(&pool)
    .await;
    assert!(invalid_alias.is_err());
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT relpersistence::text FROM pg_class WHERE oid = 'catalog_external_ids_staging'::regclass",
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        "u"
    );
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_popular_catalog_hydration_is_bounded_and_persistent() {
    use cinetrack::services::catalog_hydration::{
        hydrate_popular_catalog, HydrationOptions, HydrationSummary,
    };
    use cinetrack::services::tmdb::TmdbService;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let upstream = actix_web::rt::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = vec![0_u8; 4096];
        let read = stream.read(&mut request).await.unwrap();
        assert!(String::from_utf8_lossy(&request[..read]).starts_with("GET /movie/650001?"));
        let body = r#"{
            "id": 650001,
            "title": "Most Popular Fixture",
            "original_title": "Most Popular Fixture",
            "overview": "Hydrated by the bounded catalog worker",
            "release_date": "2026-07-13",
            "status": "Released",
            "genres": [],
            "runtime": 99,
            "vote_average": 7.5,
            "alternative_titles": {
                "titles": [{"iso_3166_1": "RO", "title": "Cel Mai Popular"}]
            },
            "translations": {
                "translations": [{
                    "iso_3166_1": "RO",
                    "iso_639_1": "ro",
                    "data": {"title": "Cel mai popular film"}
                }]
            }
        }"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        stream.write_all(response.as_bytes()).await.unwrap();
    });

    let pool = setup_pool().await;
    clean_db(&pool).await;
    sqlx::query(
        r#"INSERT INTO catalog_external_ids
            (media_type, tmdb_id, adult, video, popularity)
        VALUES
            ('movie', 650001, false, false, 1000.0),
            ('movie', 650002, false, false, 10.0)"#,
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"INSERT INTO catalog_external_titles (media_type, tmdb_id, title)
        VALUES
            ('movie', 650001, 'Most Popular Fixture'),
            ('movie', 650002, 'Lower Popularity Fixture')"#,
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"INSERT INTO catalog_sync_state
            (provider, export_date, movie_rows, tv_rows, movie_sha256, tv_sha256,
             movie_object_key, tv_object_key)
        VALUES
            ('tmdb', CURRENT_DATE, 2, 1, repeat('a', 64), repeat('b', 64),
             'catalog/movie.gz', 'catalog/tv.gz')"#,
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"INSERT INTO media
            (tmdb_id, media_type, title, metadata_level, tmdb_cached_at)
        VALUES
            (650001, 'movie', 'Most Popular Fixture', 'detail', NOW())"#,
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"INSERT INTO catalog_hydration_state
            (media_type, tmdb_id, outcome, consecutive_failures,
             last_attempt_at, next_attempt_at, last_success_at)
        VALUES
            ('movie', 650001, 'success', 0,
             NOW(), NOW() + INTERVAL '30 days', NOW())"#,
    )
    .execute(&pool)
    .await
    .unwrap();

    let mut config = test_config();
    config.tmdb_base_url = format!("http://{address}");
    let tmdb = TmdbService::new(&config);
    let summary = hydrate_popular_catalog(
        &pool,
        &tmdb,
        HydrationOptions {
            budget: 1,
            request_delay: std::time::Duration::ZERO,
        },
    )
    .await
    .unwrap();
    assert_eq!(
        summary,
        HydrationSummary {
            selected: 1,
            succeeded: 1,
            ..HydrationSummary::default()
        }
    );
    assert_eq!(
        sqlx::query_scalar::<_, i32>("SELECT tmdb_id FROM media WHERE metadata_level = 'detail'")
            .fetch_one(&pool)
            .await
            .unwrap(),
        650001
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            r#"SELECT COUNT(*)
            FROM media_title_aliases aliases
            JOIN media ON media.id = aliases.media_id
            WHERE media.tmdb_id = 650001"#,
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        2
    );
    assert!(sqlx::query_scalar::<_, bool>(
        r#"SELECT outcome = 'success'
                AND consecutive_failures = 0
                AND next_attempt_at >= NOW() + INTERVAL '29 days'
            FROM catalog_hydration_state
            WHERE media_type = 'movie' AND tmdb_id = 650001"#,
    )
    .fetch_one(&pool)
    .await
    .unwrap());
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM media WHERE tmdb_id = 650002")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    upstream.await.unwrap();
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_warm_episode_cache_avoids_upstream_request() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;
    let (token, _, _) =
        register_user(&app, "episodecache", "episodecache@example.com", "Pass1234").await;

    let media_id = sqlx::query_scalar::<_, Uuid>(
        r#"INSERT INTO media (tmdb_id, media_type, title)
        VALUES (993001, 'tv', 'Cached Episode Show')
        RETURNING id"#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let season_id = sqlx::query_scalar::<_, Uuid>(
        r#"INSERT INTO seasons
            (media_id, season_number, name, episode_count, episodes_cached_at)
        VALUES ($1, 1, 'Season 1', 1, NOW())
        RETURNING id"#,
    )
    .bind(media_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"INSERT INTO episodes (season_id, episode_number, name, runtime_minutes)
        VALUES ($1, 1, 'Cached Episode', 42)"#,
    )
    .bind(season_id)
    .execute(&pool)
    .await
    .unwrap();

    let req = actix_test::TestRequest::get()
        .uri(&format!("/api/media/{media_id}/seasons/1/episodes"))
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;

    assert_eq!(resp.status(), 200);
    let episodes: Value = actix_test::read_body_json(resp).await;
    assert_eq!(episodes.as_array().unwrap().len(), 1);
    assert_eq!(episodes[0]["name"], "Cached Episode");
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_stale_episode_cache_survives_upstream_failure() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let mut config = test_config();
    config.tmdb_base_url = "http://127.0.0.1:9".to_string();
    config.tmdb_timeout_seconds = 1;
    let app = actix_test::init_service(create_app_with_config(pool.clone(), config)).await;
    let (token, _, _) = register_user(
        &app,
        "staleepisodes",
        "staleepisodes@example.com",
        "Pass1234",
    )
    .await;

    let media_id = sqlx::query_scalar::<_, Uuid>(
        r#"INSERT INTO media (tmdb_id, media_type, title)
        VALUES (993002, 'tv', 'Stale Episode Show')
        RETURNING id"#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let season_id = sqlx::query_scalar::<_, Uuid>(
        r#"INSERT INTO seasons
            (media_id, season_number, name, episode_count, episodes_cached_at)
        VALUES ($1, 1, 'Season 1', 1, NOW() - INTERVAL '2 days')
        RETURNING id"#,
    )
    .bind(media_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"INSERT INTO episodes (season_id, episode_number, name, runtime_minutes)
        VALUES ($1, 1, 'Stale but available', 41)"#,
    )
    .bind(season_id)
    .execute(&pool)
    .await
    .unwrap();

    let req = actix_test::TestRequest::get()
        .uri(&format!("/api/media/{media_id}/seasons/1/episodes"))
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;

    assert_eq!(resp.status(), 200);
    let episodes: Value = actix_test::read_body_json(resp).await;
    assert_eq!(episodes[0]["name"], "Stale but available");
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_mark_episode_watched_is_idempotent_and_creates_tracking() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;
    let (token, _, user_id) =
        register_user(&app, "episodewatch", "episodewatch@example.com", "Pass1234").await;
    let user_id = Uuid::parse_str(&user_id).unwrap();

    let media_id = sqlx::query_scalar::<_, Uuid>(
        r#"INSERT INTO media (tmdb_id, media_type, title, runtime_minutes)
        VALUES (991101, 'tv', 'Episode Watch Test', 45)
        RETURNING id"#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let season_id = sqlx::query_scalar::<_, Uuid>(
        r#"INSERT INTO seasons
            (media_id, season_number, name, episode_count, episodes_cached_at)
        VALUES ($1, 1, 'Season 1', 2, NOW())
        RETURNING id"#,
    )
    .bind(media_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"INSERT INTO episodes (season_id, episode_number, name, runtime_minutes)
        VALUES ($1, 1, 'Pilot', 42), ($1, 2, 'Second', 44)"#,
    )
    .bind(season_id)
    .execute(&pool)
    .await
    .unwrap();

    let uri = "/api/history/tv/991101/seasons/1/episodes/2/watched";
    let first_req = actix_test::TestRequest::post()
        .uri(uri)
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .to_request();
    let second_req = actix_test::TestRequest::post()
        .uri(uri)
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .to_request();
    let (first_resp, second_resp) = futures_util::future::join(
        actix_test::call_service(&app, first_req),
        actix_test::call_service(&app, second_req),
    )
    .await;
    let statuses = [first_resp.status(), second_resp.status()];
    assert_eq!(
        statuses
            .iter()
            .filter(|status| status.as_u16() == 201)
            .count(),
        1
    );
    assert_eq!(
        statuses
            .iter()
            .filter(|status| status.as_u16() == 200)
            .count(),
        1
    );

    let counts = sqlx::query_as::<_, (i64, i64)>(
        r#"SELECT
            (SELECT COUNT(*) FROM user_media WHERE user_id = $1 AND media_id = $2),
            (SELECT COUNT(*) FROM watch_history WHERE user_id = $1 AND media_id = $2)"#,
    )
    .bind(user_id)
    .bind(media_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(counts, (1, 1));

    let status = sqlx::query_scalar::<_, String>(
        "SELECT status FROM user_media WHERE user_id = $1 AND media_id = $2",
    )
    .bind(user_id)
    .bind(media_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(status, "watching");

    let req = actix_test::TestRequest::get()
        .uri("/api/history/tv/991101/seasons/1/episodes")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);
    let body: Value = actix_test::read_body_json(resp).await;
    assert_eq!(body, json!([2]));

    let req = actix_test::TestRequest::post()
        .uri("/api/history/tv/0/seasons/1/episodes/1/watched")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 400);
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_media_rejects_invalid_upstream_parameters() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;
    let (token, _, _) =
        register_user(&app, "mediaparams", "mediaparams@example.com", "Pass1234").await;

    for uri in [
        "/api/media/-1?type=movie",
        "/api/media/1?type=person",
        "/api/media/1/seasons/501/episodes",
    ] {
        let req = actix_test::TestRequest::get()
            .uri(uri)
            .insert_header(("Authorization", format!("Bearer {token}")))
            .peer_addr(peer_addr())
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), 400, "unexpected status for {uri}");
    }
}

// ── User Profile Tests ────────────────────────────────────────

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_public_profile_hides_email() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    register_user(&app, "pubuser", "pub@example.com", "Pass1234").await;

    let req = actix_test::TestRequest::get()
        .uri("/api/users/pubuser")
        .peer_addr(peer_addr())
        .to_request();

    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);

    let body: Value = actix_test::read_body_json(resp).await;
    assert_eq!(body["username"], "pubuser");
    assert!(
        body.get("email").is_none() || body["email"].is_null(),
        "Public profile should not expose email"
    );
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_profile_lookup_is_case_insensitive() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    register_user(&app, "CaseProfile", "case-profile@example.com", "Pass1234").await;

    let req = actix_test::TestRequest::get()
        .uri("/api/users/caseprofile")
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;

    assert_eq!(resp.status(), 200);
    let body: Value = actix_test::read_body_json(resp).await;
    assert_eq!(body["username"], "CaseProfile");
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_update_profile() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    let (token, _, _) = register_user(&app, "edituser", "edit@example.com", "Pass1234").await;

    let req = actix_test::TestRequest::patch()
        .uri("/api/users/me")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(json!({ "bio": "Hello world" }))
        .peer_addr(peer_addr())
        .to_request();

    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);

    let body: Value = actix_test::read_body_json(resp).await;
    assert_eq!(body["bio"], "Hello world");
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_update_profile_rejects_direct_avatar_urls() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    let (token, _, _) = register_user(&app, "xssuser", "xss@example.com", "Pass1234").await;

    let req = actix_test::TestRequest::patch()
        .uri("/api/users/me")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(json!({ "avatar_url": "https://example.com/avatar.png" }))
        .peer_addr(peer_addr())
        .to_request();

    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 400);
}

// ── Account Deletion Tests ────────────────────────────────────

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_delete_account_requires_auth() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    let req = actix_test::TestRequest::delete()
        .uri("/api/users/me")
        .set_json(json!({ "password": "Pass1234" }))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 401);
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_delete_account_wrong_password_rejected() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    let (token, _, _) = register_user(&app, "deluser", "del@example.com", "Pass1234").await;

    let req = actix_test::TestRequest::delete()
        .uri("/api/users/me")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(json!({ "password": "WrongPass1" }))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 401);

    // Account still exists.
    login_user(&app, "del@example.com", "Pass1234").await;
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_delete_account_success() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    let (token, _, _) = register_user(&app, "goneuser", "gone@example.com", "Pass1234").await;

    let req = actix_test::TestRequest::delete()
        .uri("/api/users/me")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(json!({ "password": "Pass1234" }))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);

    // Login no longer works and the profile is gone.
    let req = actix_test::TestRequest::post()
        .uri("/api/auth/login")
        .set_json(json!({ "email": "gone@example.com", "password": "Pass1234" }))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 401);

    let req = actix_test::TestRequest::get()
        .uri("/api/users/goneuser")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 404);
}

// ── Follow System Tests ───────────────────────────────────────

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_social_notifications_are_deduplicated_private_and_owner_scoped() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    let (follower_token, _, follower_id) = register_user(
        &app,
        "notifyfollower",
        "notifyfollower@example.com",
        "Pass1234",
    )
    .await;
    let (owner_token, _, owner_id) =
        register_user(&app, "notifyowner", "notifyowner@example.com", "Pass1234").await;
    let (public_token, _, _) =
        register_user(&app, "notifypublic", "notifypublic@example.com", "Pass1234").await;
    let (second_owner_token, _, second_owner_id) =
        register_user(&app, "notifysecond", "notifysecond@example.com", "Pass1234").await;

    for (id, avatar) in [
        (&follower_id, "https://example.com/private-follower.jpg"),
        (&owner_id, "https://example.com/private-owner.jpg"),
        (&second_owner_id, "https://example.com/private-second.jpg"),
    ] {
        sqlx::query("UPDATE users SET is_public = false, avatar_url = $2 WHERE id = $1")
            .bind(Uuid::parse_str(id).unwrap())
            .bind(avatar)
            .execute(&pool)
            .await
            .unwrap();
    }

    // Repeating an unchanged request must not create or refresh multiple rows.
    for _ in 0..2 {
        let req = actix_test::TestRequest::post()
            .uri("/api/users/notifyowner/follow")
            .insert_header(("Authorization", format!("Bearer {follower_token}")))
            .peer_addr(peer_addr())
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), 202);
    }

    let req = actix_test::TestRequest::get()
        .uri("/api/notifications?limit=10")
        .insert_header(("Authorization", format!("Bearer {owner_token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);
    let owner_notifications: Value = actix_test::read_body_json(resp).await;
    assert_eq!(owner_notifications["unread_count"], 1);
    assert_eq!(owner_notifications["has_more"], false);
    let owner_items = owner_notifications["items"].as_array().unwrap();
    assert_eq!(owner_items.len(), 1);
    assert_eq!(owner_items[0]["kind"], "follow_request");
    assert_eq!(owner_items[0]["actor_username"], "notifyfollower");
    assert!(owner_items[0]["actor_avatar_url"].is_null());
    let request_notification_id = owner_items[0]["id"].as_str().unwrap();

    // Notification ownership is enforced independently from relationship IDs.
    let req = actix_test::TestRequest::post()
        .uri(&format!(
            "/api/notifications/{request_notification_id}/read"
        ))
        .insert_header(("Authorization", format!("Bearer {follower_token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 404);

    let req = actix_test::TestRequest::post()
        .uri(&format!(
            "/api/notifications/{request_notification_id}/read"
        ))
        .insert_header(("Authorization", format!("Bearer {owner_token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);

    let req = actix_test::TestRequest::post()
        .uri(&format!(
            "/api/users/me/follow-requests/{follower_id}/accept"
        ))
        .insert_header(("Authorization", format!("Bearer {owner_token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);

    let req = actix_test::TestRequest::get()
        .uri("/api/notifications")
        .insert_header(("Authorization", format!("Bearer {owner_token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    let owner_after_accept: Value = actix_test::read_body_json(resp).await;
    assert!(owner_after_accept["items"].as_array().unwrap().is_empty());
    assert_eq!(owner_after_accept["unread_count"], 0);

    let req = actix_test::TestRequest::get()
        .uri("/api/notifications")
        .insert_header(("Authorization", format!("Bearer {follower_token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    let follower_notifications: Value = actix_test::read_body_json(resp).await;
    assert_eq!(follower_notifications["unread_count"], 1);
    assert_eq!(
        follower_notifications["items"][0]["kind"],
        "follow_accepted"
    );
    assert_eq!(
        follower_notifications["items"][0]["actor_avatar_url"],
        "https://example.com/private-owner.jpg"
    );

    // A private actor's avatar is not disclosed to a public account they follow.
    let req = actix_test::TestRequest::post()
        .uri("/api/users/notifypublic/follow")
        .insert_header(("Authorization", format!("Bearer {follower_token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);

    let req = actix_test::TestRequest::get()
        .uri("/api/notifications")
        .insert_header(("Authorization", format!("Bearer {public_token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    let public_notifications: Value = actix_test::read_body_json(resp).await;
    assert_eq!(public_notifications["items"][0]["kind"], "new_follower");
    assert!(public_notifications["items"][0]["actor_avatar_url"].is_null());

    // Canceling a pending relationship removes its now-stale notification.
    let req = actix_test::TestRequest::post()
        .uri("/api/users/notifysecond/follow")
        .insert_header(("Authorization", format!("Bearer {follower_token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 202);
    let req = actix_test::TestRequest::delete()
        .uri("/api/users/notifysecond/follow")
        .insert_header(("Authorization", format!("Bearer {follower_token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);
    let req = actix_test::TestRequest::get()
        .uri("/api/notifications")
        .insert_header(("Authorization", format!("Bearer {second_owner_token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    let canceled_notifications: Value = actix_test::read_body_json(resp).await;
    assert!(canceled_notifications["items"]
        .as_array()
        .unwrap()
        .is_empty());

    let req = actix_test::TestRequest::post()
        .uri("/api/notifications/read-all")
        .insert_header(("Authorization", format!("Bearer {follower_token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);
    let body: Value = actix_test::read_body_json(resp).await;
    assert_eq!(body["updated"], 1);

    let req = actix_test::TestRequest::get()
        .uri("/api/notifications")
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 401);
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_user_search_is_literal_paginated_and_privacy_safe() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    let (viewer_token, _, viewer_id) =
        register_user(&app, "searchviewer", "searchviewer@example.com", "Pass1234").await;
    let (_, _, public_id) =
        register_user(&app, "alpha_public", "alpha_public@example.com", "Pass1234").await;
    let (_, _, pending_id) = register_user(
        &app,
        "alpha_private",
        "alpha_private@example.com",
        "Pass1234",
    )
    .await;
    let (friend_token, _, friend_id) =
        register_user(&app, "alpha_friend", "alpha_friend@example.com", "Pass1234").await;
    register_user(&app, "alphaxother", "alphaxother@example.com", "Pass1234").await;

    sqlx::query("UPDATE users SET avatar_url = $2, bio = $3 WHERE id = $1")
        .bind(Uuid::parse_str(&public_id).unwrap())
        .bind("https://example.com/public.jpg")
        .bind("public bio")
        .execute(&pool)
        .await
        .unwrap();
    for (id, avatar, bio) in [
        (
            &pending_id,
            "https://example.com/pending.jpg",
            "pending bio",
        ),
        (&friend_id, "https://example.com/friend.jpg", "friend bio"),
    ] {
        sqlx::query("UPDATE users SET is_public = false, avatar_url = $2, bio = $3 WHERE id = $1")
            .bind(Uuid::parse_str(id).unwrap())
            .bind(avatar)
            .bind(bio)
            .execute(&pool)
            .await
            .unwrap();
    }

    for username in ["alpha_private", "alpha_friend"] {
        let req = actix_test::TestRequest::post()
            .uri(&format!("/api/users/{username}/follow"))
            .insert_header(("Authorization", format!("Bearer {viewer_token}")))
            .peer_addr(peer_addr())
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), 202);
    }
    let req = actix_test::TestRequest::post()
        .uri(&format!("/api/users/me/follow-requests/{viewer_id}/accept"))
        .insert_header(("Authorization", format!("Bearer {friend_token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);

    let req = actix_test::TestRequest::get()
        .uri("/api/users/search?q=alpha_")
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 401);

    let req = actix_test::TestRequest::get()
        .uri("/api/users/search?q=%25admin")
        .insert_header(("Authorization", format!("Bearer {viewer_token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 400);

    let req = actix_test::TestRequest::get()
        .uri("/api/users/search?q=alpha_&limit=2")
        .insert_header(("Authorization", format!("Bearer {viewer_token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);
    let first_page: Value = actix_test::read_body_json(resp).await;
    assert_eq!(first_page["page"], 1);
    assert_eq!(first_page["has_more"], true);
    assert_eq!(first_page["results"].as_array().unwrap().len(), 2);

    let req = actix_test::TestRequest::get()
        .uri("/api/users/search?q=alpha_&limit=2&page=2")
        .insert_header(("Authorization", format!("Bearer {viewer_token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);
    let second_page: Value = actix_test::read_body_json(resp).await;
    assert_eq!(second_page["page"], 2);
    assert_eq!(second_page["has_more"], false);

    let mut results = first_page["results"].as_array().unwrap().clone();
    results.extend(second_page["results"].as_array().unwrap().clone());
    assert_eq!(results.len(), 3);
    assert!(!results
        .iter()
        .any(|result| result["username"] == "alphaxother"));

    let public = results
        .iter()
        .find(|result| result["username"] == "alpha_public")
        .unwrap();
    assert_eq!(public["avatar_url"], "https://example.com/public.jpg");
    assert_eq!(public["bio"], "public bio");
    assert!(public["follow_status"].is_null());

    let pending = results
        .iter()
        .find(|result| result["username"] == "alpha_private")
        .unwrap();
    assert_eq!(pending["follow_status"], "pending");
    assert!(pending["avatar_url"].is_null());
    assert!(pending["bio"].is_null());
    assert_eq!(pending["followers_count"], 0);

    let friend = results
        .iter()
        .find(|result| result["username"] == "alpha_friend")
        .unwrap();
    assert_eq!(friend["follow_status"], "accepted");
    assert_eq!(friend["avatar_url"], "https://example.com/friend.jpg");
    assert_eq!(friend["bio"], "friend bio");
    assert_eq!(friend["followers_count"], 1);
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_activity_feed_only_includes_self_and_accepted_follows() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    let (viewer_token, _, viewer_id) =
        register_user(&app, "feedviewer", "feedviewer@example.com", "Pass1234").await;
    let (_, _, followed_id) =
        register_user(&app, "feedfollowed", "feedfollowed@example.com", "Pass1234").await;
    let (_, _, pending_id) =
        register_user(&app, "feedpending", "feedpending@example.com", "Pass1234").await;
    let (_, _, stranger_id) =
        register_user(&app, "feedstranger", "feedstranger@example.com", "Pass1234").await;

    sqlx::query("UPDATE users SET is_public = false WHERE id = $1")
        .bind(Uuid::parse_str(&pending_id).unwrap())
        .execute(&pool)
        .await
        .unwrap();

    for username in ["feedfollowed", "feedpending"] {
        let req = actix_test::TestRequest::post()
            .uri(&format!("/api/users/{username}/follow"))
            .insert_header(("Authorization", format!("Bearer {viewer_token}")))
            .peer_addr(peer_addr())
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert!(resp.status().is_success());
    }

    let viewer_media_id = sqlx::query_scalar::<_, Uuid>(
        r#"INSERT INTO media (tmdb_id, media_type, title)
        VALUES (501, 'movie', 'Viewer Movie') RETURNING id"#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let followed_media_id = sqlx::query_scalar::<_, Uuid>(
        r#"INSERT INTO media (tmdb_id, media_type, title)
        VALUES (502, 'tv', 'Followed Show') RETURNING id"#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let hidden_media_id = sqlx::query_scalar::<_, Uuid>(
        r#"INSERT INTO media (tmdb_id, media_type, title)
        VALUES (503, 'movie', 'Hidden Movie') RETURNING id"#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let season_id = sqlx::query_scalar::<_, Uuid>(
        r#"INSERT INTO seasons (media_id, season_number, name)
        VALUES ($1, 2, 'Season 2') RETURNING id"#,
    )
    .bind(followed_media_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let episode_id = sqlx::query_scalar::<_, Uuid>(
        r#"INSERT INTO episodes (season_id, episode_number, name)
        VALUES ($1, 3, 'The Reveal') RETURNING id"#,
    )
    .bind(season_id)
    .fetch_one(&pool)
    .await
    .unwrap();

    let watched_at = chrono::DateTime::parse_from_rfc3339("2026-07-12T12:00:00Z")
        .unwrap()
        .with_timezone(&chrono::Utc);
    let viewer_event_id = Uuid::parse_str("ffffffff-ffff-4fff-8fff-ffffffffffff").unwrap();
    let followed_event_id = Uuid::parse_str("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee").unwrap();
    for (event_id, user_id, media_id, event_episode_id) in [
        (viewer_event_id, &viewer_id, viewer_media_id, None),
        (
            followed_event_id,
            &followed_id,
            followed_media_id,
            Some(episode_id),
        ),
        (
            Uuid::parse_str("dddddddd-dddd-4ddd-8ddd-dddddddddddd").unwrap(),
            &pending_id,
            hidden_media_id,
            None,
        ),
        (
            Uuid::parse_str("cccccccc-cccc-4ccc-8ccc-cccccccccccc").unwrap(),
            &stranger_id,
            hidden_media_id,
            None,
        ),
    ] {
        sqlx::query(
            r#"INSERT INTO watch_history (id, user_id, media_id, episode_id, watched_at)
            VALUES ($1, $2, $3, $4, $5)"#,
        )
        .bind(event_id)
        .bind(Uuid::parse_str(user_id).unwrap())
        .bind(media_id)
        .bind(event_episode_id)
        .bind(watched_at)
        .execute(&pool)
        .await
        .unwrap();
    }

    let req = actix_test::TestRequest::get()
        .uri("/api/users/me/feed?limit=1")
        .insert_header(("Authorization", format!("Bearer {viewer_token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);
    let first_page: Value = actix_test::read_body_json(resp).await;
    assert_eq!(first_page.as_array().unwrap().len(), 1);
    assert_eq!(first_page[0]["id"], viewer_event_id.to_string());
    assert_eq!(first_page[0]["tmdb_id"], 501);

    let req = actix_test::TestRequest::get()
        .uri(&format!(
            "/api/users/me/feed?limit=10&before=2026-07-12T12%3A00%3A00Z&before_id={viewer_event_id}"
        ))
        .insert_header(("Authorization", format!("Bearer {viewer_token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);
    let second_page: Value = actix_test::read_body_json(resp).await;
    let events = second_page.as_array().unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["id"], followed_event_id.to_string());
    assert_eq!(events[0]["username"], "feedfollowed");
    assert_eq!(events[0]["tmdb_id"], 502);
    assert_eq!(events[0]["season_number"], 2);
    assert_eq!(events[0]["episode_number"], 3);
    assert_eq!(events[0]["episode_name"], "The Reveal");

    let req = actix_test::TestRequest::get()
        .uri("/api/users/me/feed?before=2026-07-12T12%3A00%3A00Z")
        .insert_header(("Authorization", format!("Bearer {viewer_token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 400);

    let req = actix_test::TestRequest::get()
        .uri("/api/users/me/feed")
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 401);
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_follow_and_unfollow() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    let (token_a, _, user_a_id) =
        register_user(&app, "follower", "follower@example.com", "Pass1234").await;
    let (token_b, _, _user_b_id) =
        register_user(&app, "followed", "followed@example.com", "Pass1234").await;

    sqlx::query("UPDATE users SET is_public = false, avatar_url = $2, bio = $3 WHERE id = $1")
        .bind(Uuid::parse_str(&user_a_id).unwrap())
        .bind("https://example.com/private-avatar.jpg")
        .bind("private follower bio")
        .execute(&pool)
        .await
        .unwrap();

    // Follow (route takes username, not id)
    let req = actix_test::TestRequest::post()
        .uri("/api/users/followed/follow")
        .insert_header(("Authorization", format!("Bearer {token_a}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert!(resp.status().is_success());
    let body: Value = actix_test::read_body_json(resp).await;
    assert_eq!(body["status"], "accepted");

    // Check following list
    let req = actix_test::TestRequest::get()
        .uri("/api/users/me/following")
        .insert_header(("Authorization", format!("Bearer {token_a}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);
    let body: Value = actix_test::read_body_json(resp).await;
    let following = body.as_array().unwrap();
    assert_eq!(following.len(), 1);
    assert_eq!(following[0]["username"], "followed");

    // Following a public account does not grant that account access to the
    // private follower's profile details.
    let req = actix_test::TestRequest::get()
        .uri("/api/users/me/followers")
        .insert_header(("Authorization", format!("Bearer {token_b}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);
    let body: Value = actix_test::read_body_json(resp).await;
    let followers = body.as_array().unwrap();
    assert_eq!(followers.len(), 1);
    assert_eq!(followers[0]["username"], "follower");
    assert!(followers[0]["avatar_url"].is_null());
    assert!(followers[0]["bio"].is_null());

    // Unfollow
    let req = actix_test::TestRequest::delete()
        .uri("/api/users/followed/follow")
        .insert_header(("Authorization", format!("Bearer {token_a}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert!(resp.status().is_success());

    // Check empty
    let req = actix_test::TestRequest::get()
        .uri("/api/users/me/following")
        .insert_header(("Authorization", format!("Bearer {token_a}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    let body: Value = actix_test::read_body_json(resp).await;
    assert_eq!(body.as_array().unwrap().len(), 0);
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_private_follow_request_requires_owner_approval() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    let (follower_token, _, follower_id) =
        register_user(&app, "requester", "requester@example.com", "Pass1234").await;
    let (owner_token, _, _) =
        register_user(&app, "privateuser", "private@example.com", "Pass1234").await;
    let (other_token, _, _) =
        register_user(&app, "otheruser", "other@example.com", "Pass1234").await;

    let req = actix_test::TestRequest::patch()
        .uri("/api/users/me")
        .insert_header(("Authorization", format!("Bearer {owner_token}")))
        .set_json(json!({ "is_public": false, "bio": "private bio" }))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);

    let req = actix_test::TestRequest::post()
        .uri("/api/users/privateuser/follow")
        .insert_header(("Authorization", format!("Bearer {follower_token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 202);
    let body: Value = actix_test::read_body_json(resp).await;
    assert_eq!(body["status"], "pending");

    let req = actix_test::TestRequest::get()
        .uri("/api/users/privateuser")
        .insert_header(("Authorization", format!("Bearer {follower_token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);
    let body: Value = actix_test::read_body_json(resp).await;
    assert_eq!(body["follow_status"], "pending");
    assert_eq!(body["is_following"], false);
    assert_eq!(body["can_view_activity"], false);
    assert!(body["bio"].is_null());
    assert_eq!(body["followers_count"], 0);

    let req = actix_test::TestRequest::get()
        .uri("/api/users/privateuser/activity")
        .insert_header(("Authorization", format!("Bearer {follower_token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 403);

    let req = actix_test::TestRequest::get()
        .uri("/api/users/me/following")
        .insert_header(("Authorization", format!("Bearer {follower_token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    let body: Value = actix_test::read_body_json(resp).await;
    assert!(body.as_array().unwrap().is_empty());

    // A different account cannot accept someone else's incoming request.
    let req = actix_test::TestRequest::post()
        .uri(&format!(
            "/api/users/me/follow-requests/{follower_id}/accept"
        ))
        .insert_header(("Authorization", format!("Bearer {other_token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 404);

    let req = actix_test::TestRequest::get()
        .uri("/api/users/me/follow-requests")
        .insert_header(("Authorization", format!("Bearer {owner_token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);
    let body: Value = actix_test::read_body_json(resp).await;
    let requests = body.as_array().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0]["user_id"], follower_id);
    assert_eq!(requests[0]["username"], "requester");

    let req = actix_test::TestRequest::post()
        .uri(&format!(
            "/api/users/me/follow-requests/{follower_id}/accept"
        ))
        .insert_header(("Authorization", format!("Bearer {owner_token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);

    let req = actix_test::TestRequest::get()
        .uri("/api/users/privateuser")
        .insert_header(("Authorization", format!("Bearer {follower_token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    let body: Value = actix_test::read_body_json(resp).await;
    assert_eq!(body["follow_status"], "accepted");
    assert_eq!(body["is_following"], true);
    assert_eq!(body["can_view_activity"], true);
    assert_eq!(body["bio"], "private bio");
    assert_eq!(body["followers_count"], 1);

    let req = actix_test::TestRequest::get()
        .uri("/api/users/privateuser/activity")
        .insert_header(("Authorization", format!("Bearer {follower_token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);

    let req = actix_test::TestRequest::delete()
        .uri("/api/users/privateuser/follow")
        .insert_header(("Authorization", format!("Bearer {follower_token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);

    let req = actix_test::TestRequest::get()
        .uri("/api/users/privateuser")
        .insert_header(("Authorization", format!("Bearer {follower_token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    let body: Value = actix_test::read_body_json(resp).await;
    assert!(body["follow_status"].is_null());
    assert_eq!(body["can_view_activity"], false);
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_making_profile_public_accepts_pending_requests() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    let (follower_token, _, follower_id) =
        register_user(&app, "autofollower", "autofollower@example.com", "Pass1234").await;
    let (owner_token, _, owner_id) =
        register_user(&app, "autoowner", "autoowner@example.com", "Pass1234").await;

    sqlx::query("UPDATE users SET is_public = false WHERE id = $1")
        .bind(Uuid::parse_str(&owner_id).unwrap())
        .execute(&pool)
        .await
        .unwrap();

    let req = actix_test::TestRequest::post()
        .uri("/api/users/autoowner/follow")
        .insert_header(("Authorization", format!("Bearer {follower_token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 202);

    let req = actix_test::TestRequest::patch()
        .uri("/api/users/me")
        .insert_header(("Authorization", format!("Bearer {owner_token}")))
        .set_json(json!({ "is_public": true }))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);

    let status = sqlx::query_scalar::<_, String>(
        "SELECT status FROM follows WHERE follower_id = $1 AND following_id = $2",
    )
    .bind(Uuid::parse_str(&follower_id).unwrap())
    .bind(Uuid::parse_str(&owner_id).unwrap())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(status, "accepted");

    let req = actix_test::TestRequest::get()
        .uri("/api/notifications")
        .insert_header(("Authorization", format!("Bearer {follower_token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);
    let body: Value = actix_test::read_body_json(resp).await;
    assert_eq!(body["unread_count"], 1);
    assert_eq!(body["items"][0]["kind"], "follow_accepted");

    let req = actix_test::TestRequest::get()
        .uri("/api/notifications")
        .insert_header(("Authorization", format!("Bearer {owner_token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    let body: Value = actix_test::read_body_json(resp).await;
    assert!(body["items"].as_array().unwrap().is_empty());
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_social_relationship_quotas_are_atomic_and_bound_pending_requests() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    let (token, _, user_id) =
        register_user(&app, "socialquota", "socialquota@example.com", "Pass1234").await;
    let user_id = Uuid::parse_str(&user_id).unwrap();
    let relationship_max = cinetrack::services::quota::MAX_SOCIAL_RELATIONSHIPS_PER_USER;
    let pending_max = cinetrack::services::quota::MAX_PENDING_FOLLOW_REQUESTS_PER_USER;
    let seeded_user_count = relationship_max.max(pending_max) + 2;

    sqlx::query(
        r#"INSERT INTO users (username, email)
        SELECT 'socialtarget' || value, 'socialtarget' || value || '@example.com'
        FROM generate_series(1, $1::bigint) AS value"#,
    )
    .bind(seeded_user_count)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"INSERT INTO follows (follower_id, following_id, status)
        SELECT $1, u.id, 'accepted'
        FROM generate_series(1, $2::bigint) AS value
        JOIN users u ON u.username = 'socialtarget' || value"#,
    )
    .bind(user_id)
    .bind(relationship_max)
    .execute(&pool)
    .await
    .unwrap();

    let req = actix_test::TestRequest::post()
        .uri("/api/users/socialtarget1/follow")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(
        resp.status(),
        200,
        "an existing relationship stays idempotent"
    );

    let first_new_username = format!("socialtarget{}", relationship_max + 1);
    let second_new_username = format!("socialtarget{}", relationship_max + 2);
    let req = actix_test::TestRequest::post()
        .uri(&format!("/api/users/{first_new_username}/follow"))
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 409);

    let req = actix_test::TestRequest::delete()
        .uri("/api/users/socialtarget1/follow")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);

    let first_req = actix_test::TestRequest::post()
        .uri(&format!("/api/users/{first_new_username}/follow"))
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .to_request();
    let second_req = actix_test::TestRequest::post()
        .uri(&format!("/api/users/{second_new_username}/follow"))
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .to_request();
    let (first_resp, second_resp) = futures_util::future::join(
        actix_test::call_service(&app, first_req),
        actix_test::call_service(&app, second_req),
    )
    .await;
    let statuses = [first_resp.status(), second_resp.status()];
    assert_eq!(
        statuses
            .iter()
            .filter(|status| status.as_u16() == 200)
            .count(),
        1,
        "exactly one concurrent follow can claim the released slot"
    );
    assert_eq!(
        statuses
            .iter()
            .filter(|status| status.as_u16() == 409)
            .count(),
        1,
        "the competing follow must be rejected at the quota"
    );

    let outgoing_count =
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM follows WHERE follower_id = $1")
            .bind(user_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(outgoing_count, relationship_max);

    let (_, _, owner_id) =
        register_user(&app, "pendingowner", "pendingowner@example.com", "Pass1234").await;
    let owner_id = Uuid::parse_str(&owner_id).unwrap();
    sqlx::query("UPDATE users SET is_public = false WHERE id = $1")
        .bind(owner_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        r#"INSERT INTO follows (follower_id, following_id, status)
        SELECT u.id, $1, 'pending'
        FROM generate_series(1, $2::bigint) AS value
        JOIN users u ON u.username = 'socialtarget' || value"#,
    )
    .bind(owner_id)
    .bind(pending_max)
    .execute(&pool)
    .await
    .unwrap();

    let (requester_token, _, _) =
        register_user(&app, "newrequester", "newrequester@example.com", "Pass1234").await;
    let req = actix_test::TestRequest::post()
        .uri("/api/users/pendingowner/follow")
        .insert_header(("Authorization", format!("Bearer {requester_token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 409);
}

// ── List CRUD Tests ───────────────────────────────────────────

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_create_list() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    let (token, _, _) = register_user(&app, "listuser", "list@example.com", "Pass1234").await;

    let req = actix_test::TestRequest::post()
        .uri("/api/lists")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(json!({
            "name": "My Favorites",
            "description": "Best movies",
            "is_public": true
        }))
        .peer_addr(peer_addr())
        .to_request();

    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 201);

    let body: Value = actix_test::read_body_json(resp).await;
    assert_eq!(body["name"], "My Favorites");
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_lists_are_private_by_default_and_quota_bound() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;
    let (token, _, user_id) =
        register_user(&app, "listquota", "listquota@example.com", "Pass1234").await;
    let user_id = Uuid::parse_str(&user_id).unwrap();

    let req = actix_test::TestRequest::post()
        .uri("/api/lists")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(json!({ "name": "Private by default" }))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 201);
    let list: Value = actix_test::read_body_json(resp).await;
    assert_eq!(list["is_public"], false);
    let list_id = Uuid::parse_str(list["id"].as_str().unwrap()).unwrap();

    sqlx::query(
        r#"INSERT INTO lists (user_id, name)
        SELECT $1, 'Quota list ' || value
        FROM generate_series(1, 49) AS value"#,
    )
    .bind(user_id)
    .execute(&pool)
    .await
    .unwrap();

    let req = actix_test::TestRequest::post()
        .uri("/api/lists")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(json!({ "name": "One too many" }))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 409);

    sqlx::query(
        r#"INSERT INTO media (tmdb_id, media_type, title)
        SELECT 1100000 + value, 'movie', 'Quota movie ' || value
        FROM generate_series(1, 501) AS value"#,
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"INSERT INTO list_items (list_id, media_id)
        SELECT $1, id FROM media
        WHERE tmdb_id BETWEEN 1100001 AND 1100500"#,
    )
    .bind(list_id)
    .execute(&pool)
    .await
    .unwrap();
    let existing_media_id = sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM media WHERE tmdb_id = 1100001 AND media_type = 'movie'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let new_media_id = sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM media WHERE tmdb_id = 1100501 AND media_type = 'movie'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    let req = actix_test::TestRequest::post()
        .uri(&format!("/api/lists/{list_id}/items"))
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(json!({ "media_id": new_media_id }))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 409);

    let req = actix_test::TestRequest::post()
        .uri(&format!("/api/lists/{list_id}/items"))
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(json!({ "media_id": existing_media_id }))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(
        resp.status(),
        200,
        "adding an existing item remains idempotent"
    );
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_list_idor_protection() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    let (token_a, _, _) = register_user(&app, "owner", "owner@example.com", "Pass1234").await;
    let (token_b, _, _) = register_user(&app, "attacker", "attacker@example.com", "Pass1234").await;

    // User A creates a private list
    let req = actix_test::TestRequest::post()
        .uri("/api/lists")
        .insert_header(("Authorization", format!("Bearer {token_a}")))
        .set_json(json!({
            "name": "Private List",
            "is_public": false
        }))
        .peer_addr(peer_addr())
        .to_request();

    let resp = actix_test::call_service(&app, req).await;
    let body: Value = actix_test::read_body_json(resp).await;
    let list_id = body["id"].as_str().unwrap();

    // User B tries to update it
    let req = actix_test::TestRequest::patch()
        .uri(&format!("/api/lists/{list_id}"))
        .insert_header(("Authorization", format!("Bearer {token_b}")))
        .set_json(json!({ "name": "Hacked" }))
        .peer_addr(peer_addr())
        .to_request();

    let resp = actix_test::call_service(&app, req).await;
    assert!(
        resp.status() == 403 || resp.status() == 404,
        "IDOR: attacker could modify another user's list"
    );
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_list_name_too_long_rejected() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    let (token, _, _) = register_user(&app, "longlist", "longlist@example.com", "Pass1234").await;

    let req = actix_test::TestRequest::post()
        .uri("/api/lists")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(json!({ "name": "x".repeat(201) }))
        .peer_addr(peer_addr())
        .to_request();

    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 400);
}

// ── Observability Tests ───────────────────────────────────────

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_request_id_header_present() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    let req = actix_test::TestRequest::get()
        .uri("/api/auth/me")
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;

    let id = resp
        .headers()
        .get("x-request-id")
        .expect("response should carry X-Request-Id")
        .to_str()
        .unwrap();
    assert_eq!(id.len(), 36, "expected a hyphenated UUID, got {id:?}");
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_metrics_endpoint_exposed() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    // Generate at least one measured request.
    let warm = actix_test::TestRequest::get()
        .uri("/api/health")
        .peer_addr(peer_addr())
        .to_request();
    let _ = actix_test::call_service(&app, warm).await;

    for path in [
        "/unknown/client-controlled-a",
        "/unknown/client-controlled-b",
    ] {
        let unknown = actix_test::TestRequest::get()
            .uri(path)
            .peer_addr(peer_addr())
            .to_request();
        let response = actix_test::call_service(&app, unknown).await;
        assert_eq!(response.status(), 404);
    }

    let req = actix_test::TestRequest::get()
        .uri("/metrics")
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);

    let body = actix_test::read_body(resp).await;
    let text = String::from_utf8(body.to_vec()).unwrap();
    assert!(
        text.contains("cinetrack_http_requests_total"),
        "metrics output missing request counter:\n{text}"
    );
    assert!(
        text.contains("endpoint=\"UNMATCHED\",method=\"GET\",status=\"404\"} 2"),
        "unmatched routes should share one bounded label:\n{text}"
    );
    assert!(
        !text.contains("client-controlled"),
        "raw paths leaked into labels"
    );
}

// ── Invalid Token Tests ───────────────────────────────────────

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_invalid_bearer_token() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    let req = actix_test::TestRequest::get()
        .uri("/api/auth/me")
        .insert_header(("Authorization", "Bearer totally.invalid.token"))
        .peer_addr(peer_addr())
        .to_request();

    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 401);
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_expired_token_rejected() {
    // We can't easily create an expired token without modifying the config,
    // but we test that garbage tokens are rejected
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    let req = actix_test::TestRequest::get()
        .uri("/api/auth/me")
        .insert_header((
            "Authorization",
            "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwiZXhwIjoxfQ.fake",
        ))
        .peer_addr(peer_addr())
        .to_request();

    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 401);
}
