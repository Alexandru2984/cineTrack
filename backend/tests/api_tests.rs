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
        jwt_expiry_minutes: 15,
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
        smtp_timeout_seconds: 15,
        expo_push_access_token: None,
        expo_push_timeout_seconds: 15,
        breached_password_check: false,
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
    // Disabled outside production, so it never contacts the breach API in tests.
    let breach_checker = cinetrack::services::password_breach::BreachChecker::new(&config);

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
        .app_data(web::Data::new(breach_checker))
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
    sqlx::query("DELETE FROM email_verification_tokens")
        .execute(pool)
        .await
        .ok();
    sqlx::query("DELETE FROM two_factor_recovery_codes")
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

/// Register an unverified user and return (access_token, refresh_token, user_id).
async fn register_unverified_user(
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

/// Most integration tests exercise post-onboarding features. Mark their users
/// verified explicitly while keeping registration itself production-identical.
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
    let session = register_unverified_user(app, username, email, password).await;
    let pool = PgPool::connect(&test_db_url())
        .await
        .expect("connect to mark test user verified");
    sqlx::query("UPDATE users SET email_verified = TRUE, is_public = TRUE WHERE id = $1")
        .bind(Uuid::parse_str(&session.2).expect("registered user id"))
        .execute(&pool)
        .await
        .expect("mark test user verified");
    pool.close().await;
    session
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
        register_unverified_user(&app, "testuser", "test@example.com", "Pass1234").await;

    assert!(!token.is_empty());
    assert!(!refresh.is_empty());
    assert!(!user_id.is_empty());
    let is_public: bool = sqlx::query_scalar("SELECT is_public FROM users WHERE id = $1")
        .bind(Uuid::parse_str(&user_id).unwrap())
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(!is_public, "new accounts must start private");
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_mobile_auth_returns_rotating_tokens_without_cookies() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    let req = actix_test::TestRequest::post()
        .uri("/api/auth/mobile/register")
        .insert_header((header::USER_AGENT, "VazuteMobile/1.0 (integration test)"))
        .set_json(json!({
            "username": "mobileauth",
            "email": "mobileauth@example.com",
            "password": "Pass1234"
        }))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 201);
    assert_eq!(
        resp.headers()
            .get(header::CACHE_CONTROL)
            .and_then(|value| value.to_str().ok()),
        Some("no-store")
    );
    assert!(resp.headers().get_all(header::SET_COOKIE).next().is_none());
    let registered: Value = actix_test::read_body_json(resp).await;
    let first_refresh = registered["refresh_token"].as_str().unwrap().to_string();
    assert_eq!(first_refresh.len(), 128);
    assert!(!registered["access_token"].as_str().unwrap().is_empty());

    let req = actix_test::TestRequest::post()
        .uri("/api/auth/mobile/logout")
        .set_json(json!({ "refresh_token": first_refresh }))
        .peer_addr(peer_addr())
        .to_request();
    assert_eq!(actix_test::call_service(&app, req).await.status(), 200);

    let req = actix_test::TestRequest::post()
        .uri("/api/auth/mobile/login")
        .set_json(json!({
            "email": "mobileauth@example.com",
            "password": "Pass1234"
        }))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);
    assert!(resp.headers().get_all(header::SET_COOKIE).next().is_none());
    let logged_in: Value = actix_test::read_body_json(resp).await;
    let second_refresh = logged_in["refresh_token"].as_str().unwrap().to_string();

    let req = actix_test::TestRequest::post()
        .uri("/api/auth/mobile/refresh")
        .set_json(json!({ "refresh_token": second_refresh }))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);
    assert!(resp.headers().get_all(header::SET_COOKIE).next().is_none());
    let refreshed: Value = actix_test::read_body_json(resp).await;
    let final_refresh = refreshed["refresh_token"].as_str().unwrap().to_string();
    let access_token = refreshed["access_token"].as_str().unwrap();
    assert_ne!(final_refresh, second_refresh);

    let req = actix_test::TestRequest::get()
        .uri("/api/auth/me")
        .insert_header(("Authorization", format!("Bearer {access_token}")))
        .peer_addr(peer_addr())
        .to_request();
    assert_eq!(actix_test::call_service(&app, req).await.status(), 200);

    let req = actix_test::TestRequest::post()
        .uri("/api/auth/mobile/logout")
        .set_json(json!({ "refresh_token": &final_refresh }))
        .peer_addr(peer_addr())
        .to_request();
    assert_eq!(actix_test::call_service(&app, req).await.status(), 200);

    let req = actix_test::TestRequest::post()
        .uri("/api/auth/mobile/refresh")
        .set_json(json!({ "refresh_token": final_refresh }))
        .peer_addr(peer_addr())
        .to_request();
    assert_eq!(actix_test::call_service(&app, req).await.status(), 401);
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_mobile_logout_revokes_a_token_rotated_during_logout() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    let req = actix_test::TestRequest::post()
        .uri("/api/auth/mobile/register")
        .set_json(json!({
            "username": "logoutrotation",
            "email": "logoutrotation@example.com",
            "password": "Pass1234"
        }))
        .peer_addr(peer_addr())
        .to_request();
    let registered: Value = actix_test::call_and_read_body_json(&app, req).await;
    let original_refresh = registered["refresh_token"].as_str().unwrap().to_string();

    let req = actix_test::TestRequest::post()
        .uri("/api/auth/mobile/refresh")
        .set_json(json!({ "refresh_token": &original_refresh }))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);
    let refreshed: Value = actix_test::read_body_json(resp).await;
    let rotated_refresh = refreshed["refresh_token"].as_str().unwrap().to_string();

    // A client that started logout before the refresh response arrived only
    // knows the consumed token. Revoking its family must also revoke the child.
    let req = actix_test::TestRequest::post()
        .uri("/api/auth/mobile/logout")
        .set_json(json!({ "refresh_token": original_refresh }))
        .peer_addr(peer_addr())
        .to_request();
    assert_eq!(actix_test::call_service(&app, req).await.status(), 200);

    let req = actix_test::TestRequest::post()
        .uri("/api/auth/mobile/refresh")
        .set_json(json!({ "refresh_token": rotated_refresh }))
        .peer_addr(peer_addr())
        .to_request();
    assert_eq!(actix_test::call_service(&app, req).await.status(), 401);
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_mobile_session_list_identifies_current_refresh_token() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    let req = actix_test::TestRequest::post()
        .uri("/api/auth/mobile/register")
        .insert_header((header::USER_AGENT, "VazuteMobile/first"))
        .set_json(json!({
            "username": "mobilesessions",
            "email": "mobilesessions@example.com",
            "password": "Pass1234"
        }))
        .peer_addr(peer_addr())
        .to_request();
    let registered: Value =
        actix_test::read_body_json(actix_test::call_service(&app, req).await).await;
    let first_refresh = registered["refresh_token"].as_str().unwrap();

    let req = actix_test::TestRequest::post()
        .uri("/api/auth/mobile/login")
        .insert_header((header::USER_AGENT, "VazuteMobile/current"))
        .set_json(json!({
            "email": "mobilesessions@example.com",
            "password": "Pass1234"
        }))
        .peer_addr(peer_addr())
        .to_request();
    let logged_in: Value =
        actix_test::read_body_json(actix_test::call_service(&app, req).await).await;
    let current_refresh = logged_in["refresh_token"].as_str().unwrap();

    let req = actix_test::TestRequest::post()
        .uri("/api/auth/mobile/sessions")
        .set_json(json!({ "refresh_token": current_refresh }))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);
    assert_eq!(
        resp.headers()
            .get(header::CACHE_CONTROL)
            .and_then(|value| value.to_str().ok()),
        Some("no-store")
    );
    let sessions: Value = actix_test::read_body_json(resp).await;
    let sessions = sessions.as_array().unwrap();
    assert_eq!(sessions.len(), 2);
    let current = sessions
        .iter()
        .find(|session| session["current"] == true)
        .expect("one mobile session should be current");
    assert_eq!(current["user_agent"], "VazuteMobile/current");
    assert_eq!(
        sessions
            .iter()
            .filter(|session| session["current"] == true)
            .count(),
        1
    );

    let req = actix_test::TestRequest::post()
        .uri("/api/auth/mobile/sessions")
        .set_json(json!({ "refresh_token": first_refresh }))
        .peer_addr(peer_addr())
        .to_request();
    assert_eq!(actix_test::call_service(&app, req).await.status(), 200);

    let req = actix_test::TestRequest::post()
        .uri("/api/auth/mobile/sessions")
        .set_json(json!({ "refresh_token": "a".repeat(128) }))
        .peer_addr(peer_addr())
        .to_request();
    assert_eq!(actix_test::call_service(&app, req).await.status(), 401);
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

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_change_password_invalidates_existing_reset_token() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    let (token, _, _) = register_user(&app, "pwreset", "pwreset@example.com", "Pass1234").await;
    let reset_token = insert_reset_token(&pool, "pwreset@example.com", true).await;

    let req = actix_test::TestRequest::patch()
        .uri("/api/auth/password")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(json!({ "current_password": "Pass1234", "new_password": "NewPass5678" }))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);

    let req = actix_test::TestRequest::post()
        .uri("/api/auth/password/reset")
        .set_json(json!({ "token": reset_token, "new_password": "AttackerPass9" }))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 400);
}

// ── Email Verification Tests ──────────────────────────────────

/// Overwrite the account's issued verification token with one whose raw value
/// we know, so the endpoint can be exercised without reading it from email.
async fn set_known_verification_token(pool: &PgPool, email: &str) -> String {
    let raw = cinetrack::utils::jwt::generate_refresh_token();
    let token_hash = cinetrack::utils::jwt::hash_refresh_token(&raw);
    sqlx::query(
        "UPDATE email_verification_tokens
         SET token_hash = $2, consumed_at = NULL, expires_at = NOW() + INTERVAL '1 hour'
         WHERE user_id = (SELECT id FROM users WHERE email = $1)",
    )
    .bind(email)
    .bind(&token_hash)
    .execute(pool)
    .await
    .expect("set verification token");
    raw
}

async fn fetch_email_verified(
    app: &impl actix_web::dev::Service<
        actix_http::Request,
        Response = actix_web::dev::ServiceResponse<impl actix_web::body::MessageBody>,
        Error = actix_web::Error,
    >,
    token: &str,
) -> bool {
    let req = actix_test::TestRequest::get()
        .uri("/api/auth/me")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(app, req).await;
    assert_eq!(resp.status(), 200);
    let body: Value = actix_test::read_body_json(resp).await;
    body["email_verified"]
        .as_bool()
        .expect("email_verified flag")
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_email_verification_flow() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    let (access, _, _) =
        register_unverified_user(&app, "verifyme", "verify@example.com", "Pass1234").await;

    // A new account starts unverified and has a pending token row.
    assert!(!fetch_email_verified(&app, &access).await);
    let pending = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM email_verification_tokens
         WHERE user_id = (SELECT id FROM users WHERE email = $1)",
    )
    .bind("verify@example.com")
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(pending, 1);

    let raw = set_known_verification_token(&pool, "verify@example.com").await;

    // Confirming with the token flips the flag.
    let req = actix_test::TestRequest::post()
        .uri("/api/auth/email/verify")
        .set_json(json!({ "token": raw }))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);
    assert!(fetch_email_verified(&app, &access).await);

    // The one-time token cannot be replayed.
    let req = actix_test::TestRequest::post()
        .uri("/api/auth/email/verify")
        .set_json(json!({ "token": raw }))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 400);

    // Resending for an already-verified account is a uniform no-op success.
    let req = actix_test::TestRequest::post()
        .uri("/api/auth/email/resend")
        .insert_header(("Authorization", format!("Bearer {access}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_unverified_accounts_cannot_publish_or_use_social_and_two_factor() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    let (unverified_access, _, _) =
        register_unverified_user(&app, "unverified", "unverified@example.com", "Pass1234").await;
    let (verified_access, _, verified_id) =
        register_user(&app, "verifiedpeer", "verifiedpeer@example.com", "Pass1234").await;

    let req = actix_test::TestRequest::post()
        .uri("/api/users/unverified/follow")
        .insert_header(("Authorization", format!("Bearer {verified_access}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 202);

    let forbidden_requests = [
        actix_test::TestRequest::post()
            .uri(&format!(
                "/api/users/me/follow-requests/{verified_id}/accept"
            ))
            .insert_header(("Authorization", format!("Bearer {unverified_access}")))
            .peer_addr(peer_addr())
            .to_request(),
        actix_test::TestRequest::post()
            .uri("/api/users/verifiedpeer/follow")
            .insert_header(("Authorization", format!("Bearer {unverified_access}")))
            .peer_addr(peer_addr())
            .to_request(),
        actix_test::TestRequest::patch()
            .uri("/api/users/me")
            .insert_header(("Authorization", format!("Bearer {unverified_access}")))
            .set_json(json!({ "is_public": true }))
            .peer_addr(peer_addr())
            .to_request(),
        actix_test::TestRequest::post()
            .uri("/api/lists")
            .insert_header(("Authorization", format!("Bearer {unverified_access}")))
            .set_json(json!({ "name": "Public before verification", "is_public": true }))
            .peer_addr(peer_addr())
            .to_request(),
        actix_test::TestRequest::post()
            .uri("/api/auth/2fa/setup")
            .insert_header(("Authorization", format!("Bearer {unverified_access}")))
            .set_json(json!({ "password": "Pass1234" }))
            .peer_addr(peer_addr())
            .to_request(),
    ];
    for req in forbidden_requests {
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), 403);
    }

    // Private organization remains usable before confirmation.
    let req = actix_test::TestRequest::post()
        .uri("/api/lists")
        .insert_header(("Authorization", format!("Bearer {unverified_access}")))
        .set_json(json!({ "name": "Private before verification", "is_public": false }))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 201);

    let verification_token = set_known_verification_token(&pool, "unverified@example.com").await;
    let req = actix_test::TestRequest::post()
        .uri("/api/auth/email/verify")
        .set_json(json!({ "token": verification_token }))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);

    let req = actix_test::TestRequest::post()
        .uri(&format!(
            "/api/users/me/follow-requests/{verified_id}/accept"
        ))
        .insert_header(("Authorization", format!("Bearer {unverified_access}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);

    let req = actix_test::TestRequest::post()
        .uri("/api/auth/2fa/setup")
        .insert_header(("Authorization", format!("Bearer {unverified_access}")))
        .set_json(json!({ "password": "Pass1234" }))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_email_verification_rejects_bad_token() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    // Well-formed but unknown token → generic 400 (no account probing).
    let req = actix_test::TestRequest::post()
        .uri("/api/auth/email/verify")
        .set_json(json!({ "token": "a".repeat(128) }))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 400);

    // Malformed token shape → 400 from validation.
    let req = actix_test::TestRequest::post()
        .uri("/api/auth/email/verify")
        .set_json(json!({ "token": "too-short" }))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 400);
}

// ── Two-Factor (TOTP) Tests ───────────────────────────────────

async fn totp_secret_bytes(pool: &PgPool, email: &str) -> Vec<u8> {
    let secret_hex: String = sqlx::query_scalar("SELECT totp_secret FROM users WHERE email = $1")
        .bind(email)
        .fetch_one(pool)
        .await
        .expect("totp secret present after setup");
    hex::decode(secret_hex).expect("stored secret is valid hex")
}

fn current_totp_code(secret: &[u8]) -> String {
    let now = chrono::Utc::now().timestamp().max(0) as u64;
    cinetrack::utils::totp::code_at(secret, now)
}

/// A 6-digit code guaranteed outside the ±2-step acceptance window, so the
/// "wrong code" assertions cannot flake near a time-step boundary.
fn wrong_totp_code(secret: &[u8]) -> String {
    let now = chrono::Utc::now().timestamp().max(0) as u64;
    let window: Vec<String> = (-2..=2)
        .map(|delta| {
            let t = (now as i64 + delta * 30).max(0) as u64;
            cinetrack::utils::totp::code_at(secret, t)
        })
        .collect();
    ["000000", "111111", "222222", "333333", "444444", "555555"]
        .into_iter()
        .find(|candidate| !window.iter().any(|c| c == candidate))
        .expect("a code outside the window exists")
        .to_string()
}

async fn login_json(
    app: &impl actix_web::dev::Service<
        actix_http::Request,
        Response = actix_web::dev::ServiceResponse<impl actix_web::body::MessageBody>,
        Error = actix_web::Error,
    >,
    payload: Value,
) -> (u16, Value) {
    let req = actix_test::TestRequest::post()
        .uri("/api/auth/login")
        .set_json(payload)
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(app, req).await;
    let status = resp.status().as_u16();
    let body: Value = actix_test::read_body_json(resp).await;
    (status, body)
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_two_factor_enable_login_and_recovery() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    let (access, _, _) = register_user(&app, "mfauser", "mfa@example.com", "Pass1234").await;

    // Setup requires the account password: a stolen token alone cannot enroll.
    let req = actix_test::TestRequest::post()
        .uri("/api/auth/2fa/setup")
        .insert_header(("Authorization", format!("Bearer {access}")))
        .set_json(json!({ "password": "WrongPass9" }))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 401);

    // Setup issues a pending secret + otpauth URI without activating 2FA.
    let req = actix_test::TestRequest::post()
        .uri("/api/auth/2fa/setup")
        .insert_header(("Authorization", format!("Bearer {access}")))
        .set_json(json!({ "password": "Pass1234" }))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);
    let body: Value = actix_test::read_body_json(resp).await;
    assert!(body["otpauth_uri"]
        .as_str()
        .unwrap()
        .starts_with("otpauth://totp/"));
    assert!(body["secret"].as_str().unwrap().len() >= 16);

    let secret = totp_secret_bytes(&pool, "mfa@example.com").await;

    // A wrong code cannot activate it.
    let req = actix_test::TestRequest::post()
        .uri("/api/auth/2fa/enable")
        .insert_header(("Authorization", format!("Bearer {access}")))
        .set_json(json!({ "code": wrong_totp_code(&secret) }))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 400);

    // The correct code activates it and returns one-time recovery codes.
    let req = actix_test::TestRequest::post()
        .uri("/api/auth/2fa/enable")
        .insert_header(("Authorization", format!("Bearer {access}")))
        .set_json(json!({ "code": current_totp_code(&secret) }))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);
    let body: Value = actix_test::read_body_json(resp).await;
    let recovery = body["recovery_codes"].as_array().unwrap().clone();
    assert_eq!(recovery.len(), 10);
    let first_recovery = recovery[0].as_str().unwrap().to_string();

    // A second setup is refused now that it is enabled.
    let req = actix_test::TestRequest::post()
        .uri("/api/auth/2fa/setup")
        .insert_header(("Authorization", format!("Bearer {access}")))
        .set_json(json!({ "password": "Pass1234" }))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 409);

    // Password alone no longer logs in: the challenge flag appears.
    let (status, body) = login_json(
        &app,
        json!({ "email": "mfa@example.com", "password": "Pass1234" }),
    )
    .await;
    assert_eq!(status, 401);
    assert_eq!(body["two_factor_required"], true);

    // A valid TOTP code completes the login.
    let (status, _) = login_json(
        &app,
        json!({
            "email": "mfa@example.com",
            "password": "Pass1234",
            "totp_code": current_totp_code(&secret)
        }),
    )
    .await;
    assert_eq!(status, 200);

    // A recovery code also completes it, and cannot be reused.
    let (status, _) = login_json(
        &app,
        json!({
            "email": "mfa@example.com",
            "password": "Pass1234",
            "totp_code": first_recovery
        }),
    )
    .await;
    assert_eq!(status, 200);
    let (status, body) = login_json(
        &app,
        json!({
            "email": "mfa@example.com",
            "password": "Pass1234",
            "totp_code": first_recovery
        }),
    )
    .await;
    assert_eq!(status, 401);
    assert_eq!(body["two_factor_required"], Value::Null);

    // Disabling requires the password and restores single-factor login.
    let req = actix_test::TestRequest::post()
        .uri("/api/auth/2fa/disable")
        .insert_header(("Authorization", format!("Bearer {access}")))
        .set_json(json!({ "password": "Pass1234" }))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);

    let (status, _) = login_json(
        &app,
        json!({ "email": "mfa@example.com", "password": "Pass1234" }),
    )
    .await;
    assert_eq!(status, 200);
}

// ── Forgot / Reset Password Tests ─────────────────────────────

/// Insert a reset token directly (hashed, like the service does) and return the
/// raw token to use against the reset endpoint. `valid` controls expiry.
async fn insert_reset_token(pool: &PgPool, email: &str, valid: bool) -> String {
    let raw = cinetrack::utils::jwt::generate_refresh_token();
    let token_hash = cinetrack::utils::jwt::hash_refresh_token(&raw);
    // Two fixed statements rather than one interpolated: sqlx only accepts
    // 'static SQL, and the expiry here is a boolean toggle, not real input.
    let sql = if valid {
        "INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) \
         VALUES ((SELECT id FROM users WHERE email = $1), $2, NOW() + INTERVAL '1 hour')"
    } else {
        "INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) \
         VALUES ((SELECT id FROM users WHERE email = $1), $2, NOW() - INTERVAL '1 hour')"
    };
    sqlx::query(sql)
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

    let first_token = sqlx::query_as::<_, (Uuid, String, chrono::DateTime<chrono::Utc>)>(
        "SELECT id, token_hash, created_at
         FROM password_reset_tokens
         WHERE user_id = (SELECT id FROM users WHERE email = $1)",
    )
    .bind("forgot@example.com")
    .fetch_one(&pool)
    .await
    .expect("first reset token");

    // An immediate retry stays indistinguishable but reuses the active token.
    let req = actix_test::TestRequest::post()
        .uri("/api/auth/password/forgot")
        .set_json(json!({ "email": "forgot@example.com" }))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);

    let second_token = sqlx::query_as::<_, (Uuid, String, chrono::DateTime<chrono::Utc>)>(
        "SELECT id, token_hash, created_at
         FROM password_reset_tokens
         WHERE user_id = (SELECT id FROM users WHERE email = $1)",
    )
    .bind("forgot@example.com")
    .fetch_one(&pool)
    .await
    .expect("second reset token");
    assert_eq!(second_token, first_token);

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
async fn test_concurrent_password_reset_requests_issue_one_token() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;
    register_user(&app, "reset-race", "reset-race@example.com", "Pass1234").await;

    let config = test_config();
    let email_service = cinetrack::services::email::EmailService::new(&config);
    let first = cinetrack::services::auth::forgot_password(
        &pool,
        &config,
        &email_service,
        "reset-race@example.com",
    );
    let second = cinetrack::services::auth::forgot_password(
        &pool,
        &config,
        &email_service,
        "reset-race@example.com",
    );
    let (first_result, second_result) = tokio::join!(first, second);
    first_result.expect("first request");
    second_result.expect("second request");

    let token_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)
         FROM password_reset_tokens
         WHERE user_id = (SELECT id FROM users WHERE email = $1)",
    )
    .bind("reset-race@example.com")
    .fetch_one(&pool)
    .await
    .expect("token count");
    assert_eq!(token_count, 1);
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_consumed_password_reset_token_can_be_reissued_immediately() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;
    register_user(
        &app,
        "reset-reissue",
        "reset-reissue@example.com",
        "Pass1234",
    )
    .await;

    let config = test_config();
    let email_service = cinetrack::services::email::EmailService::new(&config);
    cinetrack::services::auth::forgot_password(
        &pool,
        &config,
        &email_service,
        "reset-reissue@example.com",
    )
    .await
    .expect("first request");
    let first_hash: String = sqlx::query_scalar(
        "UPDATE password_reset_tokens
         SET consumed_at = NOW()
         WHERE user_id = (SELECT id FROM users WHERE email = $1)
         RETURNING token_hash",
    )
    .bind("reset-reissue@example.com")
    .fetch_one(&pool)
    .await
    .expect("consume first token");

    cinetrack::services::auth::forgot_password(
        &pool,
        &config,
        &email_service,
        "reset-reissue@example.com",
    )
    .await
    .expect("second request");
    let (second_hash, consumed_at): (String, Option<chrono::DateTime<chrono::Utc>>) =
        sqlx::query_as(
            "SELECT token_hash, consumed_at
             FROM password_reset_tokens
             WHERE user_id = (SELECT id FROM users WHERE email = $1)",
        )
        .bind("reset-reissue@example.com")
        .fetch_one(&pool)
        .await
        .expect("reissued token");

    assert_ne!(second_hash, first_hash);
    assert!(consumed_at.is_none());
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

    let req = actix_test::TestRequest::post()
        .uri("/api/tracking/lookup")
        .set_json(json!({
            "items": [{ "tmdb_id": 1, "media_type": "movie" }]
        }))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 401);
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_tracking_lookup_is_complete_beyond_first_list_page() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;
    let (token, _, user_id) =
        register_user(&app, "lookupuser", "lookup@example.com", "Pass1234").await;
    let user_id = Uuid::parse_str(&user_id).unwrap();
    const TMDB_BASE: i32 = 1_310_000;

    sqlx::query(
        r#"INSERT INTO media (tmdb_id, media_type, title)
        SELECT $1 + value, 'movie', 'Lookup movie ' || value
        FROM generate_series(1, 150) AS value"#,
    )
    .bind(TMDB_BASE)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"INSERT INTO user_media (user_id, media_id, status)
        SELECT $1, id, 'plan_to_watch'
        FROM media WHERE tmdb_id > $2 AND tmdb_id <= $2 + 150"#,
    )
    .bind(user_id)
    .bind(TMDB_BASE)
    .execute(&pool)
    .await
    .unwrap();

    let requested_tmdb_id = TMDB_BASE + 149;
    let req = actix_test::TestRequest::post()
        .uri("/api/tracking/lookup")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(json!({
            "items": [
                { "tmdb_id": requested_tmdb_id, "media_type": "movie" },
                { "tmdb_id": requested_tmdb_id, "media_type": "movie" },
                { "tmdb_id": TMDB_BASE + 999, "media_type": "movie" }
            ]
        }))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);
    let body: Value = actix_test::read_body_json(resp).await;
    let matches = body.as_array().unwrap();
    assert_eq!(
        matches.len(),
        1,
        "duplicates and untracked titles are omitted"
    );
    assert_eq!(matches[0]["tmdb_id"], requested_tmdb_id);
    assert_eq!(matches[0]["status"], "plan_to_watch");
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

    let req = actix_test::TestRequest::patch()
        .uri(&format!("/api/tracking/{tracking_id}"))
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .set_json(json!({ "rating": 9, "review": "Very good" }))
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);
    let body: Value = actix_test::read_body_json(resp).await;
    assert_eq!(body["rating"], 9);
    assert_eq!(body["review"], "Very good");

    let req = actix_test::TestRequest::patch()
        .uri(&format!("/api/tracking/{tracking_id}"))
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .set_json(json!({ "is_favorite": true }))
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);
    let body: Value = actix_test::read_body_json(resp).await;
    assert_eq!(body["rating"], 9, "omitted rating must be preserved");
    assert_eq!(
        body["review"], "Very good",
        "omitted review must be preserved"
    );

    let req = actix_test::TestRequest::patch()
        .uri(&format!("/api/tracking/{tracking_id}"))
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .set_json(json!({ "rating": null, "review": null }))
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);
    let body: Value = actix_test::read_body_json(resp).await;
    assert!(body["rating"].is_null());
    assert!(body["review"].is_null());

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
        VALUES ($1, 1, 'Season 1', 4)
        RETURNING id"#,
    )
    .bind(media_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"INSERT INTO episodes
            (season_id, episode_number, name, runtime_minutes, air_date)
        VALUES
            ($1, 1, 'Unknown date', 42, NULL),
            ($1, 2, 'Already aired', 44, CURRENT_DATE - 1),
            ($1, 3, 'Airs today', 45, CURRENT_DATE),
            ($1, 4, 'Future episode', 46, CURRENT_DATE + 1)"#,
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
    assert_eq!(counts, (3, 0));

    let future_watches = sqlx::query_scalar::<_, i64>(
        r#"SELECT COUNT(*)
        FROM watch_history history
        JOIN episodes ON episodes.id = history.episode_id
        WHERE history.user_id = $1
          AND history.media_id = $2
          AND episodes.air_date > CURRENT_DATE"#,
    )
    .bind(user_id)
    .bind(media_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(future_watches, 0);

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
    assert_eq!(history_count, 3);

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
async fn test_history_lists_manual_rewatches_with_episode_context() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;
    let (token, _, _) = register_user(
        &app,
        "historycontext",
        "historycontext@example.com",
        "Pass1234",
    )
    .await;

    let media_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO media (id, tmdb_id, media_type, title) VALUES ($1, 771001, 'tv', 'History Show')",
    )
    .bind(media_id)
    .execute(&pool)
    .await
    .unwrap();
    let season_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO seasons (id, media_id, season_number, name) VALUES ($1, $2, 3, 'Season 3')",
    )
    .bind(season_id)
    .bind(media_id)
    .execute(&pool)
    .await
    .unwrap();
    let episode_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO episodes (id, season_id, episode_number, name) VALUES ($1, $2, 7, 'Again')",
    )
    .bind(episode_id)
    .bind(season_id)
    .execute(&pool)
    .await
    .unwrap();

    for watched_at in ["2026-07-10T20:00:00Z", "2026-07-12T20:00:00Z"] {
        let req = actix_test::TestRequest::post()
            .uri("/api/history")
            .insert_header(("Authorization", format!("Bearer {token}")))
            .set_json(json!({
                "media_id": media_id,
                "episode_id": episode_id,
                "watched_at": watched_at
            }))
            .peer_addr(peer_addr())
            .to_request();
        assert_eq!(actix_test::call_service(&app, req).await.status(), 201);
    }

    let req = actix_test::TestRequest::get()
        .uri("/api/history?limit=20&page=1")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .to_request();
    let response: Value =
        actix_test::read_body_json(actix_test::call_service(&app, req).await).await;
    let items = response.as_array().unwrap();
    assert_eq!(items.len(), 2, "rewatches remain separate history events");
    assert_eq!(items[0]["tmdb_id"], 771001);
    assert_eq!(items[0]["season_number"], 3);
    assert_eq!(items[0]["episode_number"], 7);
    assert_eq!(items[0]["episode_name"], "Again");
    assert_eq!(items[0]["watched_at"], "2026-07-12T20:00:00Z");
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
async fn test_wrapped_year_scoped_recap() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    let (token, _, user_id_str) =
        register_user(&app, "wrapped", "wrapped@example.com", "Pass1234").await;
    let user_id = Uuid::parse_str(&user_id_str).unwrap();

    let movie_id = sqlx::query_scalar::<_, Uuid>(
        r#"INSERT INTO media (tmdb_id, media_type, title, runtime_minutes, genres)
        VALUES (881001, 'movie', 'Wrapped Movie', 120, '[{"name": "Action"}]')
        RETURNING id"#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let show_id = sqlx::query_scalar::<_, Uuid>(
        r#"INSERT INTO media (tmdb_id, media_type, title, runtime_minutes, genres)
        VALUES (881002, 'tv', 'Wrapped Show', 30, '[{"name": "Drama"}]')
        RETURNING id"#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    for (media_id, watched_at) in [
        (movie_id, "2023-03-15T20:00:00Z"),
        (show_id, "2023-06-01T20:00:00Z"),
        (show_id, "2023-06-02T20:00:00Z"), // consecutive day → streak of 2
        (show_id, "2023-07-10T20:00:00Z"),
        (movie_id, "2024-01-05T20:00:00Z"), // different year → excluded from 2023
    ] {
        sqlx::query(
            "INSERT INTO watch_history (user_id, media_id, watched_at) VALUES ($1, $2, $3::timestamptz)",
        )
        .bind(user_id)
        .bind(media_id)
        .bind(watched_at)
        .execute(&pool)
        .await
        .unwrap();
    }

    let req = actix_test::TestRequest::get()
        .uri("/api/stats/me/wrapped?year=2023")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);
    let body: Value = actix_test::read_body_json(resp).await;

    assert_eq!(body["year"], 2023);
    assert_eq!(body["total_watches"], 4); // the 2024 event is excluded
    assert_eq!(body["movies_watched"], 1);
    assert_eq!(body["episodes_watched"], 3);
    assert_eq!(body["distinct_titles"], 2);
    assert_eq!(body["total_hours"], 3.5); // (120 + 3*30) / 60
    assert_eq!(body["longest_streak"], 2);
    assert_eq!(body["first_watch"], "2023-03-15");
    assert_eq!(body["last_watch"], "2023-07-10");

    // Most-watched title first.
    assert_eq!(body["top_shows"][0]["title"], "Wrapped Show");
    assert_eq!(body["top_shows"][0]["count"], 3);
    assert_eq!(body["top_shows"][1]["title"], "Wrapped Movie");

    // Full 12-month series with June carrying two events.
    let monthly = body["monthly"].as_array().unwrap();
    assert_eq!(monthly.len(), 12);
    let june = monthly.iter().find(|m| m["month"] == 6).unwrap();
    assert_eq!(june["count"], 2);

    // Genres counted once per distinct title.
    let genres: Vec<&str> = body["top_genres"]
        .as_array()
        .unwrap()
        .iter()
        .map(|g| g["genre"].as_str().unwrap())
        .collect();
    assert!(genres.contains(&"Action") && genres.contains(&"Drama"));
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
async fn test_watch_providers_require_auth_and_serve_from_cache() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    // Unauthenticated access is rejected before any upstream call.
    let req = actix_test::TestRequest::get()
        .uri("/api/media/603/watch-providers?type=movie&region=RO")
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 401);

    let (token, _, _) = register_user(&app, "wpuser", "wp@example.com", "Pass1234").await;

    // Seed a fresh cache entry so the handler never contacts TMDB in tests.
    let payload = json!({
        "results": {
            "RO": {
                "link": "https://www.themoviedb.org/movie/603/watch",
                "flatrate": [
                    {"provider_id": 8, "provider_name": "Netflix", "logo_path": "/nf.jpg", "display_priority": 1}
                ],
                "rent": [
                    {"provider_id": 3, "provider_name": "Apple TV", "logo_path": "/apple.jpg", "display_priority": 0}
                ]
            }
        }
    });
    let cache_key = cinetrack::services::tmdb::TmdbService::provider_cache_key(
        "watch_providers",
        &["movie", "603"],
    );
    sqlx::query(
        "INSERT INTO provider_response_cache
            (provider, cache_key, endpoint, payload, fetched_at, expires_at, stale_until)
         VALUES ('tmdb', $1, 'watch/providers', $2, NOW(), NOW() + INTERVAL '1 hour', NOW() + INTERVAL '3 hours')",
    )
    .bind(&cache_key)
    .bind(&payload)
    .execute(&pool)
    .await
    .expect("seed watch providers cache");

    let req = actix_test::TestRequest::get()
        .uri("/api/media/603/watch-providers?type=movie&region=RO")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);
    let body: Value = actix_test::read_body_json(resp).await;
    assert_eq!(body["region"], "RO");
    assert_eq!(body["stream"][0]["name"], "Netflix");
    assert_eq!(body["rent"][0]["name"], "Apple TV");
    assert!(body["buy"].as_array().unwrap().is_empty());

    // An unknown region yields empty buckets, not an error.
    let req = actix_test::TestRequest::get()
        .uri("/api/media/603/watch-providers?type=movie&region=JP")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);
    let body: Value = actix_test::read_body_json(resp).await;
    assert_eq!(body["region"], "JP");
    assert!(body["stream"].as_array().unwrap().is_empty());
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
async fn test_tracked_release_schedule_sync_persists_episodes_and_cadence() {
    use cinetrack::services::release_schedule::{
        sync_tracked_release_schedules, ReleaseScheduleOptions, ReleaseScheduleSummary,
    };
    use cinetrack::services::tmdb::TmdbService;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let upstream = actix_web::rt::spawn(async move {
        let responses = [
            (
                "/tv/770001?",
                "200 OK",
                r#"{
                    "id": 770001,
                    "name": "Schedule Fixture",
                    "original_name": "Schedule Fixture",
                    "status": "Returning Series",
                    "genres": [],
                    "episode_run_time": [48],
                    "vote_average": 8.1,
                    "seasons": [{
                        "id": 771001,
                        "season_number": 1,
                        "name": "Season 1",
                        "episode_count": 2,
                        "air_date": "2026-07-01"
                    }, {
                        "id": 771002,
                        "season_number": 2,
                        "name": "Season 2",
                        "episode_count": 1,
                        "air_date": "2026-08-01"
                    }],
                    "next_episode_to_air": {"season_number": 2},
                    "last_episode_to_air": {"season_number": 1}
                }"#,
            ),
            ("/tv/770001/season/2?", "404 Not Found", r#"{}"#),
            (
                "/tv/770001/season/1?",
                "200 OK",
                r#"{
                    "episodes": [{
                        "episode_number": 1,
                        "name": "Fresh Episode",
                        "overview": "Synced without a request-time provider call.",
                        "runtime": 48,
                        "air_date": "2026-07-14",
                        "still_path": "/fresh.jpg"
                    }]
                }"#,
            ),
            (
                "/movie/770002/release_dates?",
                "200 OK",
                r#"{
                    "id": 770002,
                    "results": [{
                        "iso_3166_1": "RO",
                        "release_dates": [{
                            "release_date": "2026-09-01T00:00:00.000Z",
                            "type": 4
                        }]
                    }]
                }"#,
            ),
        ];

        for (expected_path, status, body) in responses {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = vec![0_u8; 4096];
            let read = stream.read(&mut request).await.unwrap();
            assert!(String::from_utf8_lossy(&request[..read])
                .starts_with(&format!("GET {expected_path}")));
            let response = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        }
    });

    let pool = setup_pool().await;
    clean_db(&pool).await;
    let user_id = sqlx::query_scalar::<_, Uuid>(
        r#"INSERT INTO users (username, email)
        VALUES ('scheduleuser', 'schedule@example.com')
        RETURNING id"#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let media_id = sqlx::query_scalar::<_, Uuid>(
        r#"INSERT INTO media
            (tmdb_id, media_type, title, status, metadata_level)
        VALUES (770001, 'tv', 'Schedule Fixture', 'Returning Series', 'detail')
        RETURNING id"#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"INSERT INTO user_media (user_id, media_id, status)
        VALUES ($1, $2, 'watching')"#,
    )
    .bind(user_id)
    .bind(media_id)
    .execute(&pool)
    .await
    .unwrap();
    let movie_id = sqlx::query_scalar::<_, Uuid>(
        r#"INSERT INTO media
            (tmdb_id, media_type, title, release_date, status, metadata_level)
        VALUES (770002, 'movie', 'Old Planned Movie', '2001-01-01', 'Released', 'detail')
        RETURNING id"#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"INSERT INTO user_media (user_id, media_id, status)
        VALUES ($1, $2, 'plan_to_watch')"#,
    )
    .bind(user_id)
    .bind(movie_id)
    .execute(&pool)
    .await
    .unwrap();

    let mut config = test_config();
    config.tmdb_base_url = format!("http://{address}");
    let tmdb = TmdbService::new(&config);
    let options = ReleaseScheduleOptions {
        budget: 10,
        request_delay: std::time::Duration::ZERO,
    };
    let summary = sync_tracked_release_schedules(&pool, &tmdb, options)
        .await
        .unwrap();

    assert_eq!(
        summary,
        ReleaseScheduleSummary {
            selected: 2,
            succeeded: 2,
            tv_titles: 1,
            movie_titles: 1,
            refreshed_seasons: 1,
            cached_movie_dates: 1,
            ..ReleaseScheduleSummary::default()
        }
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            r#"SELECT episodes.name
            FROM episodes
            JOIN seasons ON seasons.id = episodes.season_id
            WHERE seasons.media_id = $1 AND episodes.episode_number = 1"#,
        )
        .bind(media_id)
        .fetch_one(&pool)
        .await
        .unwrap(),
        "Fresh Episode"
    );
    assert!(sqlx::query_scalar::<_, bool>(
        r#"SELECT outcome = 'success'
                AND consecutive_failures = 0
                AND next_attempt_at >= NOW() + INTERVAL '5 hours'
            FROM release_schedule_sync_state
            WHERE media_id = $1"#,
    )
    .bind(media_id)
    .fetch_one(&pool)
    .await
    .unwrap());
    assert!(sqlx::query_scalar::<_, bool>(
        r#"SELECT EXISTS (
                SELECT 1 FROM media_release_dates
                WHERE media_id = $1
                  AND country_code = 'RO'
                  AND release_type = 4
                  AND release_date = '2026-09-01'
            ) AND EXISTS (
                SELECT 1 FROM release_schedule_sync_state
                WHERE media_id = $1
                  AND outcome = 'success'
                  AND next_attempt_at >= NOW() + INTERVAL '29 days'
            )"#,
    )
    .bind(movie_id)
    .fetch_one(&pool)
    .await
    .unwrap());

    let second = sync_tracked_release_schedules(&pool, &tmdb, options)
        .await
        .unwrap();
    assert_eq!(second, ReleaseScheduleSummary::default());
    upstream.await.unwrap();
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_calendar_lists_new_and_regional_upcoming_releases() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;
    let (token, _, user_id) =
        register_user(&app, "calendar", "calendar@example.com", "Pass1234").await;
    let (_, _, other_user_id) = register_user(
        &app,
        "othercalendar",
        "othercalendar@example.com",
        "Pass1234",
    )
    .await;
    let user_id = Uuid::parse_str(&user_id).unwrap();
    let other_user_id = Uuid::parse_str(&other_user_id).unwrap();
    let today = chrono::Utc::now().date_naive();

    let show_id = sqlx::query_scalar::<_, Uuid>(
        r#"INSERT INTO media (tmdb_id, media_type, title, status)
        VALUES (780001, 'tv', 'Calendar Show', 'Returning Series')
        RETURNING id"#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let season_id = sqlx::query_scalar::<_, Uuid>(
        r#"INSERT INTO seasons (media_id, season_number, name, episode_count)
        VALUES ($1, 1, 'Season 1', 4)
        RETURNING id"#,
    )
    .bind(show_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO user_media (user_id, media_id, status) VALUES ($1, $2, 'watching')")
        .bind(user_id)
        .bind(show_id)
        .execute(&pool)
        .await
        .unwrap();

    let today_episode = sqlx::query_scalar::<_, Uuid>(
        r#"INSERT INTO episodes
            (season_id, episode_number, name, runtime_minutes, air_date, still_path)
        VALUES ($1, 1, 'Today Episode', 45, $2, '/today.jpg')
        RETURNING id"#,
    )
    .bind(season_id)
    .bind(today)
    .fetch_one(&pool)
    .await
    .unwrap();
    let watched_episode = sqlx::query_scalar::<_, Uuid>(
        r#"INSERT INTO episodes (season_id, episode_number, name, air_date)
        VALUES ($1, 2, 'Already Watched', $2)
        RETURNING id"#,
    )
    .bind(season_id)
    .bind(today - chrono::Duration::days(1))
    .fetch_one(&pool)
    .await
    .unwrap();
    let old_planned_episode = sqlx::query_scalar::<_, Uuid>(
        r#"INSERT INTO episodes (season_id, episode_number, name, air_date)
        VALUES ($1, 3, 'Saved Earlier', $2)
        RETURNING id"#,
    )
    .bind(season_id)
    .bind(today - chrono::Duration::days(45))
    .fetch_one(&pool)
    .await
    .unwrap();
    let backlog_episode = sqlx::query_scalar::<_, Uuid>(
        r#"INSERT INTO episodes (season_id, episode_number, name, air_date)
        VALUES ($1, 5, 'Deep Backlog', $2)
        RETURNING id"#,
    )
    .bind(season_id)
    .bind(today - chrono::Duration::days(400))
    .fetch_one(&pool)
    .await
    .unwrap();
    let future_episode = sqlx::query_scalar::<_, Uuid>(
        r#"INSERT INTO episodes
            (season_id, episode_number, name, air_date, still_path)
        VALUES ($1, 4, 'Next Episode', $2, '/next.jpg')
        RETURNING id"#,
    )
    .bind(season_id)
    .bind(today + chrono::Duration::days(5))
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"INSERT INTO watch_history (user_id, media_id, episode_id)
        VALUES ($1, $2, $3)"#,
    )
    .bind(user_id)
    .bind(show_id)
    .bind(watched_episode)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO episode_plans (user_id, episode_id) VALUES ($1, $2)")
        .bind(user_id)
        .bind(old_planned_episode)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        r#"INSERT INTO release_schedule_sync_state
            (media_id, outcome, consecutive_failures, last_attempt_at,
             next_attempt_at, last_success_at)
        VALUES ($1, 'success', 0, NOW(), NOW() + INTERVAL '6 hours', NOW())"#,
    )
    .bind(show_id)
    .execute(&pool)
    .await
    .unwrap();

    let movie_id = sqlx::query_scalar::<_, Uuid>(
        r#"INSERT INTO media (tmdb_id, media_type, title, release_date)
        VALUES (780002, 'movie', 'Regional Movie', $1)
        RETURNING id"#,
    )
    .bind(today + chrono::Duration::days(20))
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO user_media (user_id, media_id, status) VALUES ($1, $2, 'plan_to_watch')",
    )
    .bind(user_id)
    .bind(movie_id)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"INSERT INTO media_release_dates
            (media_id, country_code, release_type, release_date)
        VALUES
            ($1, 'RO', 3, $2),
            ($1, 'RO', 4, $3),
            ($1, 'US', 3, $4)"#,
    )
    .bind(movie_id)
    .bind(today + chrono::Duration::days(3))
    .bind(today + chrono::Duration::days(7))
    .bind(today + chrono::Duration::days(9))
    .execute(&pool)
    .await
    .unwrap();

    let other_show_id = sqlx::query_scalar::<_, Uuid>(
        r#"INSERT INTO media (tmdb_id, media_type, title)
        VALUES (780003, 'tv', 'Private Other Show')
        RETURNING id"#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let other_season_id = sqlx::query_scalar::<_, Uuid>(
        r#"INSERT INTO seasons (media_id, season_number) VALUES ($1, 1) RETURNING id"#,
    )
    .bind(other_show_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO user_media (user_id, media_id, status) VALUES ($1, $2, 'watching')")
        .bind(other_user_id)
        .bind(other_show_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        r#"INSERT INTO episodes (season_id, episode_number, name, air_date)
        VALUES ($1, 1, 'Must Not Leak', $2)"#,
    )
    .bind(other_season_id)
    .bind(today)
    .execute(&pool)
    .await
    .unwrap();

    let req = actix_test::TestRequest::get()
        .uri(&format!("/api/calendar/new?today={today}&limit=1"))
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);
    let first_page: Value = actix_test::read_body_json(resp).await;
    assert_eq!(first_page["items"].as_array().unwrap().len(), 1);
    assert_eq!(
        first_page["items"][0]["episode_id"],
        today_episode.to_string()
    );
    assert!(first_page["next_cursor"].is_object());

    let cursor_date = first_page["next_cursor"]["before_date"].as_str().unwrap();
    let cursor_id = first_page["next_cursor"]["before_id"].as_str().unwrap();
    let req = actix_test::TestRequest::get()
        .uri(&format!(
            "/api/calendar/new?today={today}&limit=10&before_date={cursor_date}&before_id={cursor_id}"
        ))
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);
    let second_page: Value = actix_test::read_body_json(resp).await;
    assert_eq!(second_page["items"].as_array().unwrap().len(), 2);
    assert_eq!(
        second_page["items"][0]["episode_id"],
        old_planned_episode.to_string()
    );
    assert_eq!(second_page["items"][0]["is_planned"], true);
    assert_eq!(
        second_page["items"][1]["episode_id"],
        backlog_episode.to_string()
    );
    assert_eq!(second_page["next_cursor"], Value::Null);

    let req = actix_test::TestRequest::get()
        .uri(&format!("/api/calendar/up-next?today={today}&limit=6"))
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .to_request();
    let up_next: Value = actix_test::call_and_read_body_json(&app, req).await;
    assert_eq!(up_next["items"].as_array().unwrap().len(), 1);
    assert_eq!(up_next["items"][0]["episode_id"], today_episode.to_string());
    assert_eq!(up_next["items"][0]["is_planned"], false);
    assert_ne!(
        up_next["items"][0]["episode_id"],
        old_planned_episode.to_string()
    );
    assert!(up_next["items"]
        .as_array()
        .unwrap()
        .iter()
        .all(|item| item["title"] != "Private Other Show"));

    let req = actix_test::TestRequest::get()
        .uri(&format!("/api/calendar/summary?today={today}"))
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .to_request();
    let summary: Value = actix_test::call_and_read_body_json(&app, req).await;
    assert_eq!(summary["new_count"], 1);
    assert_eq!(summary["planned_count"], 1);
    assert!(summary["last_synced_at"].is_string());

    let req = actix_test::TestRequest::get()
        .uri(&format!("/api/calendar/upcoming?today={today}&days=30"))
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);
    let upcoming: Value = actix_test::read_body_json(resp).await;
    assert_eq!(upcoming["country_code"], "RO");
    assert_eq!(upcoming["items"].as_array().unwrap().len(), 3);
    assert_eq!(upcoming["items"][0]["release_type"], 3);
    assert_eq!(upcoming["items"][1]["item_id"], future_episode.to_string());
    assert_eq!(upcoming["items"][2]["release_type"], 4);
    assert!(upcoming["items"]
        .as_array()
        .unwrap()
        .iter()
        .all(|item| item["title"] != "Private Other Show"));

    let req = actix_test::TestRequest::put()
        .uri("/api/calendar/preferences")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .set_json(json!({"country_code": "us"}))
        .to_request();
    let preferences: Value = actix_test::call_and_read_body_json(&app, req).await;
    assert_eq!(preferences["country_code"], "US");

    let req = actix_test::TestRequest::get()
        .uri(&format!(
            "/api/calendar/upcoming?today={today}&days=30&type=movie"
        ))
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .to_request();
    let us_upcoming: Value = actix_test::call_and_read_body_json(&app, req).await;
    assert_eq!(us_upcoming["items"].as_array().unwrap().len(), 1);
    assert_eq!(us_upcoming["items"][0]["release_type"], 3);
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_calendar_episode_actions_are_idempotent_and_owner_scoped() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;
    let (token, _, user_id) =
        register_user(&app, "episodeplan", "episodeplan@example.com", "Pass1234").await;
    let (other_token, _, other_user_id) = register_user(
        &app,
        "episodeplanother",
        "episodeplanother@example.com",
        "Pass1234",
    )
    .await;
    let user_id = Uuid::parse_str(&user_id).unwrap();
    let other_user_id = Uuid::parse_str(&other_user_id).unwrap();

    let media_id = sqlx::query_scalar::<_, Uuid>(
        r#"INSERT INTO media (tmdb_id, media_type, title)
        VALUES (781001, 'tv', 'Episode Actions')
        RETURNING id"#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let season_id = sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO seasons (media_id, season_number) VALUES ($1, 1) RETURNING id",
    )
    .bind(media_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let episode_id = sqlx::query_scalar::<_, Uuid>(
        r#"INSERT INTO episodes (season_id, episode_number, name, air_date)
        VALUES ($1, 1, 'Action Episode', CURRENT_DATE)
        RETURNING id"#,
    )
    .bind(season_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO user_media (user_id, media_id, status) VALUES ($1, $2, 'plan_to_watch')",
    )
    .bind(user_id)
    .bind(media_id)
    .execute(&pool)
    .await
    .unwrap();

    let req = actix_test::TestRequest::get()
        .uri("/api/calendar/new")
        .peer_addr(peer_addr())
        .to_request();
    assert_eq!(actix_test::call_service(&app, req).await.status(), 401);

    let req = actix_test::TestRequest::get()
        .uri("/api/calendar/up-next")
        .peer_addr(peer_addr())
        .to_request();
    assert_eq!(actix_test::call_service(&app, req).await.status(), 401);

    let plan_uri = format!("/api/calendar/episodes/{episode_id}/plan");
    for expected_status in [201, 200] {
        let req = actix_test::TestRequest::put()
            .uri(&plan_uri)
            .insert_header(("Authorization", format!("Bearer {token}")))
            .peer_addr(peer_addr())
            .to_request();
        assert_eq!(
            actix_test::call_service(&app, req).await.status(),
            expected_status
        );
    }

    let req = actix_test::TestRequest::delete()
        .uri(&plan_uri)
        .insert_header(("Authorization", format!("Bearer {other_token}")))
        .peer_addr(peer_addr())
        .to_request();
    assert_eq!(actix_test::call_service(&app, req).await.status(), 200);
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM episode_plans WHERE user_id = $1 AND episode_id = $2",
        )
        .bind(user_id)
        .bind(episode_id)
        .fetch_one(&pool)
        .await
        .unwrap(),
        1
    );

    for (request_token, expected_status) in [(&other_token, 404), (&token, 201), (&token, 200)] {
        let req = actix_test::TestRequest::post()
            .uri(&format!("/api/calendar/episodes/{episode_id}/watched"))
            .insert_header(("Authorization", format!("Bearer {request_token}")))
            .peer_addr(peer_addr())
            .to_request();
        assert_eq!(
            actix_test::call_service(&app, req).await.status(),
            expected_status
        );
    }

    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM watch_history WHERE user_id = $1 AND episode_id = $2",
        )
        .bind(user_id)
        .bind(episode_id)
        .fetch_one(&pool)
        .await
        .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT status FROM user_media WHERE user_id = $1 AND media_id = $2",
        )
        .bind(user_id)
        .bind(media_id)
        .fetch_one(&pool)
        .await
        .unwrap(),
        "watching"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM episode_plans WHERE user_id = $1 AND episode_id = $2",
        )
        .bind(user_id)
        .bind(episode_id)
        .fetch_one(&pool)
        .await
        .unwrap(),
        0
    );

    let trigger_episode_id = sqlx::query_scalar::<_, Uuid>(
        r#"INSERT INTO episodes (season_id, episode_number, name, air_date)
        VALUES ($1, 2, 'Trigger Episode', CURRENT_DATE)
        RETURNING id"#,
    )
    .bind(season_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO episode_plans (user_id, episode_id) VALUES ($1, $2)")
        .bind(user_id)
        .bind(trigger_episode_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        r#"INSERT INTO watch_history (user_id, media_id, episode_id)
        VALUES ($1, $2, $3)"#,
    )
    .bind(user_id)
    .bind(media_id)
    .bind(trigger_episode_id)
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM episode_plans WHERE user_id = $1 AND episode_id = $2",
        )
        .bind(user_id)
        .bind(trigger_episode_id)
        .fetch_one(&pool)
        .await
        .unwrap(),
        0
    );

    let req = actix_test::TestRequest::put()
        .uri(&plan_uri)
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .to_request();
    assert_eq!(actix_test::call_service(&app, req).await.status(), 409);

    let req = actix_test::TestRequest::put()
        .uri("/api/calendar/preferences")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .set_json(json!({"country_code": "../../../"}))
        .to_request();
    assert_eq!(actix_test::call_service(&app, req).await.status(), 400);

    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM watch_history WHERE user_id = $1")
            .bind(other_user_id)
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
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
async fn test_bulk_episode_watch_is_idempotent_bounded_and_updates_progress() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;
    let (token, _, user_id) =
        register_user(&app, "bulkwatch", "bulkwatch@example.com", "Pass1234").await;
    let user_id = Uuid::parse_str(&user_id).unwrap();

    let media_id = sqlx::query_scalar::<_, Uuid>(
        r#"INSERT INTO media
            (tmdb_id, media_type, title, status, metadata_level, tmdb_cached_at)
        VALUES (991201, 'tv', 'Bulk Watch Test', 'Returning Series', 'detail', NOW())
        RETURNING id"#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let season_one_id = sqlx::query_scalar::<_, Uuid>(
        r#"INSERT INTO seasons
            (media_id, season_number, name, episode_count, episodes_cached_at)
        VALUES ($1, 1, 'Season 1', 2, NOW())
        RETURNING id"#,
    )
    .bind(media_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let season_two_id = sqlx::query_scalar::<_, Uuid>(
        r#"INSERT INTO seasons
            (media_id, season_number, name, episode_count, episodes_cached_at)
        VALUES ($1, 2, 'Season 2', 4, NOW())
        RETURNING id"#,
    )
    .bind(media_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let season_one_episodes = sqlx::query_scalar::<_, Uuid>(
        r#"INSERT INTO episodes (season_id, episode_number, name, air_date)
        VALUES
            ($1, 1, 'S1 First', CURRENT_DATE - 20),
            ($1, 2, 'S1 Second', CURRENT_DATE - 10)
        RETURNING id"#,
    )
    .bind(season_one_id)
    .fetch_all(&pool)
    .await
    .unwrap();
    let season_two_episodes = sqlx::query_scalar::<_, Uuid>(
        r#"INSERT INTO episodes (season_id, episode_number, name, air_date)
        VALUES
            ($1, 1, 'S2 First', CURRENT_DATE - 3),
            ($1, 2, 'S2 Second', CURRENT_DATE - 2),
            ($1, 3, 'S2 Third', CURRENT_DATE - 1),
            ($1, 4, 'S2 Future', CURRENT_DATE + 10)
        RETURNING id"#,
    )
    .bind(season_two_id)
    .fetch_all(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"INSERT INTO user_media (user_id, media_id, status)
        VALUES ($1, $2, 'on_hold')"#,
    )
    .bind(user_id)
    .bind(media_id)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"INSERT INTO watch_history (user_id, media_id, episode_id)
        VALUES ($1, $2, $3)"#,
    )
    .bind(user_id)
    .bind(media_id)
    .bind(season_one_episodes[0])
    .execute(&pool)
    .await
    .unwrap();
    for episode_id in [season_one_episodes[1], season_two_episodes[0]] {
        sqlx::query("INSERT INTO episode_plans (user_id, episode_id) VALUES ($1, $2)")
            .bind(user_id)
            .bind(episode_id)
            .execute(&pool)
            .await
            .unwrap();
    }

    let through_uri = "/api/history/tv/991201/seasons/2/episodes/2/watched-through";
    let first_req = actix_test::TestRequest::post()
        .uri(through_uri)
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .to_request();
    let second_req = actix_test::TestRequest::post()
        .uri(through_uri)
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .to_request();
    let (first_resp, second_resp) = futures_util::future::join(
        actix_test::call_service(&app, first_req),
        actix_test::call_service(&app, second_req),
    )
    .await;
    assert_eq!(first_resp.status(), 200);
    assert_eq!(second_resp.status(), 200);
    let first_body: Value = actix_test::read_body_json(first_resp).await;
    let second_body: Value = actix_test::read_body_json(second_resp).await;
    assert_eq!(
        first_body["marked_count"].as_i64().unwrap()
            + second_body["marked_count"].as_i64().unwrap(),
        3
    );
    assert_eq!(first_body["candidate_count"], 4);
    assert_eq!(second_body["candidate_count"], 4);

    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT status FROM user_media WHERE user_id = $1 AND media_id = $2",
        )
        .bind(user_id)
        .bind(media_id)
        .fetch_one(&pool)
        .await
        .unwrap(),
        "watching"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM episode_plans WHERE user_id = $1",)
            .bind(user_id)
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );

    let req = actix_test::TestRequest::get()
        .uri("/api/history/tv/991201/progress")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .to_request();
    let progress: Value = actix_test::call_and_read_body_json(&app, req).await;
    assert_eq!(progress[0]["season_number"], 1);
    assert_eq!(progress[0]["watched_count"], 2);
    assert_eq!(progress[1]["season_number"], 2);
    assert_eq!(progress[1]["watched_count"], 2);

    let req = actix_test::TestRequest::post()
        .uri("/api/history/tv/991201/seasons/2/watched")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);
    let body: Value = actix_test::read_body_json(resp).await;
    assert_eq!(body["candidate_count"], 3);
    assert_eq!(body["marked_count"], 1);
    assert_eq!(body["already_watched_count"], 2);

    assert_eq!(
        sqlx::query_scalar::<_, Vec<i32>>(
            r#"SELECT ARRAY_AGG(DISTINCT episodes.episode_number ORDER BY episodes.episode_number)
            FROM watch_history
            JOIN episodes ON episodes.id = watch_history.episode_id
            WHERE watch_history.user_id = $1
              AND episodes.season_id = $2"#,
        )
        .bind(user_id)
        .bind(season_two_id)
        .fetch_one(&pool)
        .await
        .unwrap(),
        vec![1, 2, 3]
    );

    for uri in [
        "/api/history/tv/991201/seasons/2/episodes/4/watched",
        "/api/history/tv/991201/seasons/2/episodes/4/watched-through",
    ] {
        let req = actix_test::TestRequest::post()
            .uri(uri)
            .insert_header(("Authorization", format!("Bearer {token}")))
            .peer_addr(peer_addr())
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), 400, "{uri} must reject future episodes");
    }

    let req = actix_test::TestRequest::post()
        .uri(&format!(
            "/api/calendar/episodes/{}/watched",
            season_two_episodes[3]
        ))
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 400);

    let future_watch_count = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM watch_history WHERE user_id = $1 AND episode_id = $2",
    )
    .bind(user_id)
    .bind(season_two_episodes[3])
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(future_watch_count, 0);
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_episode_detail_is_authenticated_and_user_scoped() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;
    let (token, _, user_id) = register_user(
        &app,
        "episodedetail",
        "episodedetail@example.com",
        "Pass1234",
    )
    .await;
    let user_id = Uuid::parse_str(&user_id).unwrap();
    let (other_token, _, _) =
        register_user(&app, "episodeother", "episodeother@example.com", "Pass1234").await;

    let media_id = sqlx::query_scalar::<_, Uuid>(
        r#"INSERT INTO media
            (tmdb_id, media_type, title, poster_path, backdrop_path)
        VALUES (991301, 'tv', 'Episode Detail Show', '/poster.jpg', '/backdrop.jpg')
        RETURNING id"#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let season_id = sqlx::query_scalar::<_, Uuid>(
        r#"INSERT INTO seasons (media_id, season_number, name, episode_count)
        VALUES ($1, 2, 'Second Season', 1)
        RETURNING id"#,
    )
    .bind(media_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let episode_id = sqlx::query_scalar::<_, Uuid>(
        r#"INSERT INTO episodes
            (season_id, episode_number, name, overview, runtime_minutes, air_date, still_path)
        VALUES ($1, 3, 'The Detail', 'A complete synopsis', 52, CURRENT_DATE, '/still.jpg')
        RETURNING id"#,
    )
    .bind(season_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO user_media (user_id, media_id, status) VALUES ($1, $2, 'watching')")
        .bind(user_id)
        .bind(media_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO episode_plans (user_id, episode_id) VALUES ($1, $2)")
        .bind(user_id)
        .bind(episode_id)
        .execute(&pool)
        .await
        .unwrap();

    let uri = format!("/api/media/episodes/{episode_id}");
    let req = actix_test::TestRequest::get()
        .uri(&uri)
        .peer_addr(peer_addr())
        .to_request();
    assert_eq!(actix_test::call_service(&app, req).await.status(), 401);

    let req = actix_test::TestRequest::get()
        .uri(&uri)
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);
    let body: Value = actix_test::read_body_json(resp).await;
    assert_eq!(body["episode_id"], episode_id.to_string());
    assert_eq!(body["tmdb_id"], 991301);
    assert_eq!(body["season_number"], 2);
    assert_eq!(body["episode_number"], 3);
    assert_eq!(body["tracking_status"], "watching");
    assert_eq!(body["is_available"], true);
    assert_eq!(body["is_planned"], true);
    assert_eq!(body["is_watched"], false);
    assert_eq!(body["watch_count"], 0);
    assert!(body["last_watched_at"].is_null());

    let req = actix_test::TestRequest::get()
        .uri(&uri)
        .insert_header(("Authorization", format!("Bearer {other_token}")))
        .peer_addr(peer_addr())
        .to_request();
    let other_body: Value = actix_test::call_and_read_body_json(&app, req).await;
    assert!(other_body["tracking_status"].is_null());
    assert_eq!(other_body["is_planned"], false);
    assert_eq!(other_body["is_watched"], false);

    sqlx::query("INSERT INTO watch_history (user_id, media_id, episode_id) VALUES ($1, $2, $3)")
        .bind(user_id)
        .bind(media_id)
        .bind(episode_id)
        .execute(&pool)
        .await
        .unwrap();
    let req = actix_test::TestRequest::get()
        .uri(&uri)
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .to_request();
    let watched_body: Value = actix_test::call_and_read_body_json(&app, req).await;
    assert_eq!(watched_body["is_planned"], false);
    assert_eq!(watched_body["is_watched"], true);
    assert_eq!(watched_body["watch_count"], 1);
    assert!(watched_body["last_watched_at"].is_string());

    let missing_uri = format!("/api/media/episodes/{}", Uuid::new_v4());
    let req = actix_test::TestRequest::get()
        .uri(&missing_uri)
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .to_request();
    assert_eq!(actix_test::call_service(&app, req).await.status(), 404);
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

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_delete_account_keeps_account_when_stored_avatar_cannot_be_removed() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    let (token, _, user_id) =
        register_user(&app, "storedavatar", "storedavatar@example.com", "Pass1234").await;
    let user_id = Uuid::parse_str(&user_id).unwrap();
    sqlx::query("UPDATE users SET avatar_url = $2 WHERE id = $1")
        .bind(user_id)
        .bind("https://assets.example.com/avatars/storedavatar.png")
        .execute(&pool)
        .await
        .unwrap();

    let req = actix_test::TestRequest::delete()
        .uri("/api/users/me")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(json!({ "password": "Pass1234" }))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 503);

    login_user(&app, "storedavatar@example.com", "Pass1234").await;
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
    // A private profile hides its follow-graph size from unapproved viewers.
    assert!(pending["followers_count"].is_null());

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
    assert!(body["followers_count"].is_null());
    assert!(body["following_count"].is_null());

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
        r#"INSERT INTO users (username, email, email_verified, is_public)
        SELECT 'socialtarget' || value, 'socialtarget' || value || '@example.com', TRUE, TRUE
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
async fn test_list_full_owner_flow_and_public_visibility() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;
    let (token, _, _) = register_user(&app, "listflow", "listflow@example.com", "Pass1234").await;
    let media_id = sqlx::query_scalar::<_, Uuid>(
        r#"INSERT INTO media (tmdb_id, media_type, title)
        VALUES (1200001, 'movie', 'List Flow Movie')
        RETURNING id"#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    let req = actix_test::TestRequest::post()
        .uri("/api/lists")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(json!({
            "name": "Shareable",
            "description": "Public collection",
            "is_public": true
        }))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 201);
    let created: Value = actix_test::read_body_json(resp).await;
    let list_id = Uuid::parse_str(created["id"].as_str().unwrap()).unwrap();

    let req = actix_test::TestRequest::post()
        .uri(&format!("/api/lists/{list_id}/items"))
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(json!({ "media_id": media_id }))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 201);

    let req = actix_test::TestRequest::get()
        .uri("/api/lists/me?limit=50")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);
    let mine: Value = actix_test::read_body_json(resp).await;
    assert_eq!(mine[0]["item_count"], 1);

    let req = actix_test::TestRequest::get()
        .uri(&format!("/api/lists/{list_id}"))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);
    let public_detail: Value = actix_test::read_body_json(resp).await;
    assert_eq!(public_detail["list"]["name"], "Shareable");
    assert_eq!(public_detail["items"][0]["id"], media_id.to_string());

    let req = actix_test::TestRequest::patch()
        .uri(&format!("/api/lists/{list_id}"))
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(json!({ "name": "Private now", "is_public": false }))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);

    let req = actix_test::TestRequest::get()
        .uri(&format!("/api/lists/{list_id}"))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 404);

    let req = actix_test::TestRequest::delete()
        .uri(&format!("/api/lists/{list_id}/items/{media_id}"))
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);

    let req = actix_test::TestRequest::get()
        .uri(&format!("/api/lists/{list_id}"))
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);
    let private_detail: Value = actix_test::read_body_json(resp).await;
    assert_eq!(private_detail["items"].as_array().unwrap().len(), 0);

    let req = actix_test::TestRequest::delete()
        .uri(&format!("/api/lists/{list_id}"))
        .insert_header(("Authorization", format!("Bearer {token}")))
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);

    let remaining = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM lists WHERE id = $1")
        .bind(list_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(remaining, 0);
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

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_client_error_reports_require_auth_and_validate_payloads() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;
    let payload = json!({
        "error_name": "TypeError",
        "message": "Cannot read property",
        "stack": "TypeError: Cannot read property at App.tsx:10",
        "component_stack": "at App",
        "platform": "android",
        "app_version": "1.1.0",
        "is_fatal": false,
        "occurred_at": chrono::Utc::now().to_rfc3339(),
    });

    let req = actix_test::TestRequest::post()
        .uri("/api/client-errors")
        .set_json(&payload)
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 401);

    let (token, _, _) = register_user(
        &app,
        "crashreporter",
        "crashreporter@example.com",
        "Pass1234",
    )
    .await;
    let req = actix_test::TestRequest::post()
        .uri("/api/client-errors")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(&payload)
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 202);

    let invalid = json!({
        "error_name": "   ",
        "message": "x".repeat(1001),
        "platform": "desktop",
        "app_version": "1.0.0?token=secret",
        "is_fatal": false,
        "occurred_at": chrono::Utc::now().to_rfc3339(),
        "unexpected": true,
    });
    let req = actix_test::TestRequest::post()
        .uri("/api/client-errors")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(invalid)
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 400);

    let stale = json!({
        "error_name": "Error",
        "message": "Old report",
        "platform": "ios",
        "app_version": "1.1.0",
        "is_fatal": true,
        "occurred_at": (chrono::Utc::now() - chrono::Duration::days(8)).to_rfc3339(),
    });
    let req = actix_test::TestRequest::post()
        .uri("/api/client-errors")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(stale)
        .peer_addr(peer_addr())
        .to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 400);
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_push_device_registration_and_secret_revocation() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;
    let token = "ExpoPushToken[abcdefghijklmnopqrstuv]";
    let secret = "ab".repeat(32);
    let payload = json!({
        "expo_push_token": token,
        "unregister_secret": secret,
        "platform": "android",
        "app_version": "1.1.0",
        "utc_offset_minutes": 180,
    });

    let req = actix_test::TestRequest::put()
        .uri("/api/push/devices")
        .set_json(&payload)
        .peer_addr(peer_addr())
        .to_request();
    assert_eq!(actix_test::call_service(&app, req).await.status(), 401);

    let (access_token, _, user_id) =
        register_user(&app, "pushdevice", "pushdevice@example.com", "Pass1234").await;
    let req = actix_test::TestRequest::put()
        .uri("/api/push/devices")
        .insert_header(("Authorization", format!("Bearer {access_token}")))
        .set_json(&payload)
        .peer_addr(peer_addr())
        .to_request();
    let response = actix_test::call_service(&app, req).await;
    assert_eq!(response.status(), 200);
    let response: Value = actix_test::read_body_json(response).await;
    assert_eq!(response, json!({ "enabled": true }));

    let stored = sqlx::query_as::<_, (String, String, String, i16)>(
        "SELECT user_id::text, unregister_secret_hash, platform, utc_offset_minutes
         FROM push_devices WHERE expo_push_token = $1",
    )
    .bind(token)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(stored.0, user_id);
    assert_eq!(stored.1.len(), 64);
    assert_ne!(stored.1, secret);
    assert_eq!(stored.2, "android");
    assert_eq!(stored.3, 180);

    let push_device_id =
        sqlx::query_scalar::<_, Uuid>("SELECT id FROM push_devices WHERE expo_push_token = $1")
            .bind(token)
            .fetch_one(&pool)
            .await
            .unwrap();
    sqlx::query(
        "INSERT INTO release_push_deliveries
            (push_device_id, event_key, event_kind, title, body, tmdb_id, media_type)
         VALUES ($1, $2, 'episode', 'Old account show', 'S01E01 is available today', 42, 'tv')",
    )
    .bind(push_device_id)
    .bind(format!("episode:{}", Uuid::new_v4()))
    .execute(&pool)
    .await
    .unwrap();

    // A token claimed by another account/installation must not inherit queued content.
    let (second_access_token, _, second_user_id) =
        register_user(&app, "pushdevice2", "pushdevice2@example.com", "Pass1234").await;
    let replacement_secret = "ef".repeat(32);
    let req = actix_test::TestRequest::put()
        .uri("/api/push/devices")
        .insert_header(("Authorization", format!("Bearer {second_access_token}")))
        .set_json(json!({
            "expo_push_token": token,
            "unregister_secret": &replacement_secret,
            "platform": "android",
            "app_version": "1.1.0",
            "utc_offset_minutes": 180,
        }))
        .peer_addr(peer_addr())
        .to_request();
    assert_eq!(actix_test::call_service(&app, req).await.status(), 200);
    let replacement_owner = sqlx::query_scalar::<_, String>(
        "SELECT user_id::text FROM push_devices WHERE expo_push_token = $1",
    )
    .bind(token)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(replacement_owner, second_user_id);
    let delivery_count =
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM release_push_deliveries")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(delivery_count, 0);

    let req = actix_test::TestRequest::post()
        .uri("/api/push/devices/revoke")
        .set_json(json!({
            "expo_push_token": token,
            "unregister_secret": &secret,
        }))
        .peer_addr(peer_addr())
        .to_request();
    assert_eq!(actix_test::call_service(&app, req).await.status(), 200);
    let count = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM push_devices")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 1);

    let req = actix_test::TestRequest::post()
        .uri("/api/push/devices/revoke")
        .set_json(json!({
            "expo_push_token": token,
            "unregister_secret": &replacement_secret,
        }))
        .peer_addr(peer_addr())
        .to_request();
    let response = actix_test::call_service(&app, req).await;
    assert_eq!(response.status(), 200);
    let response: Value = actix_test::read_body_json(response).await;
    assert_eq!(response, json!({ "enabled": false }));
    let count = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM push_devices")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0);

    let invalid = json!({
        "expo_push_token": "not-a-token",
        "unregister_secret": "not-a-secret",
        "platform": "android",
        "app_version": "1.1.0?bad",
        "utc_offset_minutes": 900,
        "unexpected": true,
    });
    let req = actix_test::TestRequest::put()
        .uri("/api/push/devices")
        .insert_header(("Authorization", format!("Bearer {access_token}")))
        .set_json(invalid)
        .peer_addr(peer_addr())
        .to_request();
    assert_eq!(actix_test::call_service(&app, req).await.status(), 400);
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_release_push_outbox_is_local_personalized_and_idempotent() {
    use cinetrack::services::push::enqueue_due_release_pushes;

    let pool = setup_pool().await;
    clean_db(&pool).await;
    let user_id = sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO users (username, email)
         VALUES ('pushoutbox', 'pushoutbox@example.com') RETURNING id",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO push_devices
            (user_id, expo_push_token, unregister_secret_hash, platform,
             app_version, utc_offset_minutes, enabled_at)
         VALUES ($1, 'ExpoPushToken[abcdefghijklmnopqrstuv]', repeat('a', 64),
                 'android', '1.1.0', 0, NOW() - INTERVAL '1 hour')",
    )
    .bind(user_id)
    .execute(&pool)
    .await
    .unwrap();

    let show_id = sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO media (tmdb_id, media_type, title)
         VALUES (880001, 'tv', 'Push Show') RETURNING id",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let season_id = sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO seasons (media_id, season_number, name)
         VALUES ($1, 1, 'Season 1') RETURNING id",
    )
    .bind(show_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let due_episode_id = sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO episodes (season_id, episode_number, name, air_date)
         VALUES ($1, 1, 'Today', CURRENT_DATE) RETURNING id",
    )
    .bind(season_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let watched_episode_id = sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO episodes (season_id, episode_number, name, air_date)
         VALUES ($1, 2, 'Already watched', CURRENT_DATE) RETURNING id",
    )
    .bind(season_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO user_media (user_id, media_id, status)
         VALUES ($1, $2, 'watching')",
    )
    .bind(user_id)
    .bind(show_id)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO watch_history (user_id, media_id, episode_id)
         VALUES ($1, $2, $3)",
    )
    .bind(user_id)
    .bind(show_id)
    .bind(watched_episode_id)
    .execute(&pool)
    .await
    .unwrap();

    let movie_id = sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO media (tmdb_id, media_type, title, release_date)
         VALUES (880002, 'movie', 'Push Movie', CURRENT_DATE + 10) RETURNING id",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO user_media (user_id, media_id, status)
         VALUES ($1, $2, 'plan_to_watch')",
    )
    .bind(user_id)
    .bind(movie_id)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO media_release_dates
            (media_id, country_code, release_type, release_date)
         VALUES ($1, 'RO', 4, CURRENT_DATE)",
    )
    .bind(movie_id)
    .execute(&pool)
    .await
    .unwrap();

    assert_eq!(enqueue_due_release_pushes(&pool).await.unwrap(), 2);
    assert_eq!(enqueue_due_release_pushes(&pool).await.unwrap(), 0);
    let deliveries = sqlx::query_as::<_, (String, String, i32, String)>(
        "SELECT event_kind, event_key, tmdb_id, status
         FROM release_push_deliveries ORDER BY event_kind",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(deliveries.len(), 2);
    assert_eq!(deliveries[0].0, "episode");
    assert_eq!(deliveries[0].1, format!("episode:{due_episode_id}"));
    assert_eq!(deliveries[0].2, 880001);
    assert_eq!(deliveries[0].3, "pending");
    assert_eq!(deliveries[1].0, "movie");
    assert_eq!(deliveries[1].2, 880002);
    assert_eq!(deliveries[1].3, "pending");
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
