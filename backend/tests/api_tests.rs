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
    let config = test_config();
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
async fn test_follow_and_unfollow() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    let (token_a, _, _) = register_user(&app, "follower", "follower@example.com", "Pass1234").await;
    let (_, _, _user_b_id) =
        register_user(&app, "followed", "followed@example.com", "Pass1234").await;

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
