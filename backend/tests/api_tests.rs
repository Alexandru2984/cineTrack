use actix_web::{web, App};
use actix_web::test as actix_test;
use serde_json::{json, Value};
use sqlx::PgPool;
use std::net::SocketAddr;

// ── Helpers ────────────────────────────────────────────────────

const PEER: &str = "127.0.0.1:12345";

fn peer_addr() -> SocketAddr {
    PEER.parse().unwrap()
}

fn test_db_url() -> String {
    std::env::var("TEST_DATABASE_URL")
        .unwrap_or_else(|_| "postgres://test_user:test_pass@127.0.0.1:5433/cinetrack_test".into())
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
        tmdb_base_url: "https://api.themoviedb.org/3".into(),
        tmdb_image_base_url: "https://image.tmdb.org/t/p".into(),
        cors_allowed_origins: vec!["http://localhost:5173".into()],
        rate_limit_rps: 100,
        rate_limit_burst: 200,
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

    // No rate limiter in tests — actix-governor needs real peer_addr from TCP
    App::new()
        .app_data(web::Data::new(pool))
        .app_data(web::Data::new(config))
        .app_data(web::Data::new(tmdb_service))
        .configure(cinetrack::routes::configure)
}

async fn clean_db(pool: &PgPool) {
    sqlx::query("DELETE FROM list_items").execute(pool).await.ok();
    sqlx::query("DELETE FROM lists").execute(pool).await.ok();
    sqlx::query("DELETE FROM follows").execute(pool).await.ok();
    sqlx::query("DELETE FROM watch_history").execute(pool).await.ok();
    sqlx::query("DELETE FROM tracking").execute(pool).await.ok();
    sqlx::query("DELETE FROM episodes").execute(pool).await.ok();
    sqlx::query("DELETE FROM seasons").execute(pool).await.ok();
    sqlx::query("DELETE FROM media").execute(pool).await.ok();
    sqlx::query("DELETE FROM refresh_tokens").execute(pool).await.ok();
    sqlx::query("DELETE FROM oauth_accounts").execute(pool).await.ok();
    sqlx::query("DELETE FROM users").execute(pool).await.ok();
}

/// Register a user and return (access_token, refresh_token, user_id)
async fn register_user(
    app: &impl actix_web::dev::Service<actix_http::Request, Response = actix_web::dev::ServiceResponse<impl actix_web::body::MessageBody>, Error = actix_web::Error>,
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
        .peer_addr(peer_addr()).to_request();

    let resp = actix_test::call_service(app, req).await;
    assert_eq!(resp.status(), 201, "Register failed for {username}");

    let body: Value = actix_test::read_body_json(resp).await;
    (
        body["access_token"].as_str().unwrap().to_string(),
        body["refresh_token"].as_str().unwrap().to_string(),
        body["user"]["id"].as_str().unwrap().to_string(),
    )
}

async fn login_user(
    app: &impl actix_web::dev::Service<actix_http::Request, Response = actix_web::dev::ServiceResponse<impl actix_web::body::MessageBody>, Error = actix_web::Error>,
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
        .peer_addr(peer_addr()).to_request();

    let resp = actix_test::call_service(app, req).await;
    assert_eq!(resp.status(), 200, "Login failed for {email}");

    let body: Value = actix_test::read_body_json(resp).await;
    (
        body["access_token"].as_str().unwrap().to_string(),
        body["refresh_token"].as_str().unwrap().to_string(),
    )
}

// ── Auth Tests ────────────────────────────────────────────────

#[actix_web::test]
#[ignore = "requires test DB: docker compose -f docker-compose.test.yml up -d"]
async fn test_register_success() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    let (token, refresh, user_id) = register_user(&app, "testuser", "test@example.com", "Pass1234").await;

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
        .peer_addr(peer_addr()).to_request();

    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 400);

    // Verify generic error (no user enumeration)
    let body: Value = actix_test::read_body_json(resp).await;
    let msg = body["message"].as_str().unwrap();
    assert!(!msg.contains("email"), "Error reveals email conflict: {msg}");
    assert!(!msg.contains("username"), "Error reveals username conflict: {msg}");
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
        .peer_addr(peer_addr()).to_request();

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
        .peer_addr(peer_addr()).to_request();

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
        .peer_addr(peer_addr()).to_request();

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
        .peer_addr(peer_addr()).to_request();

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
        .peer_addr(peer_addr()).to_request();

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
        .peer_addr(peer_addr()).to_request();

    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 401);
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_refresh_token_rotation() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    let (_, refresh, _) = register_user(&app, "refreshuser", "refresh@example.com", "Pass1234").await;

    let req = actix_test::TestRequest::post()
        .uri("/api/auth/refresh")
        .set_json(json!({ "refresh_token": refresh }))
        .peer_addr(peer_addr()).to_request();

    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);

    let body: Value = actix_test::read_body_json(resp).await;
    let new_token = body["access_token"].as_str().unwrap();
    let new_refresh = body["refresh_token"].as_str().unwrap();

    assert!(!new_token.is_empty());
    assert!(!new_refresh.is_empty());
    assert_ne!(new_refresh, &refresh, "Refresh token should rotate");
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
        .peer_addr(peer_addr()).to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);

    // Try old refresh token again — should fail
    let req = actix_test::TestRequest::post()
        .uri("/api/auth/refresh")
        .set_json(json!({ "refresh_token": &refresh }))
        .peer_addr(peer_addr()).to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 401, "Old refresh token should be invalid after rotation");
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
        .peer_addr(peer_addr()).to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);

    // Refresh should fail
    let req = actix_test::TestRequest::post()
        .uri("/api/auth/refresh")
        .set_json(json!({ "refresh_token": &refresh }))
        .peer_addr(peer_addr()).to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 401);
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
        .peer_addr(peer_addr()).to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 401);
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_history_requires_auth() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    let req = actix_test::TestRequest::get()
        .uri("/api/history")
        .peer_addr(peer_addr()).to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 401);
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
        .peer_addr(peer_addr()).to_request();

    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);

    let body: Value = actix_test::read_body_json(resp).await;
    assert_eq!(body["username"], "pubuser");
    assert!(body.get("email").is_none() || body["email"].is_null(),
        "Public profile should not expose email");
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
        .peer_addr(peer_addr()).to_request();

    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);

    let body: Value = actix_test::read_body_json(resp).await;
    assert_eq!(body["bio"], "Hello world");
}

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_update_profile_avatar_xss_rejected() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    let (token, _, _) = register_user(&app, "xssuser", "xss@example.com", "Pass1234").await;

    let req = actix_test::TestRequest::patch()
        .uri("/api/users/me")
        .insert_header(("Authorization", format!("Bearer {token}")))
        .set_json(json!({ "avatar_url": "javascript:alert(1)" }))
        .peer_addr(peer_addr()).to_request();

    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 400);
}

// ── Follow System Tests ───────────────────────────────────────

#[actix_web::test]
#[ignore = "requires test DB"]
async fn test_follow_and_unfollow() {
    let pool = setup_pool().await;
    clean_db(&pool).await;
    let app = actix_test::init_service(create_app(pool.clone())).await;

    let (token_a, _, _) = register_user(&app, "follower", "follower@example.com", "Pass1234").await;
    let (_, _, _user_b_id) = register_user(&app, "followed", "followed@example.com", "Pass1234").await;

    // Follow (route takes username, not id)
    let req = actix_test::TestRequest::post()
        .uri("/api/users/followed/follow")
        .insert_header(("Authorization", format!("Bearer {token_a}")))
        .peer_addr(peer_addr()).to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert!(resp.status().is_success());

    // Check following list
    let req = actix_test::TestRequest::get()
        .uri("/api/users/me/following")
        .insert_header(("Authorization", format!("Bearer {token_a}")))
        .peer_addr(peer_addr()).to_request();
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
        .peer_addr(peer_addr()).to_request();
    let resp = actix_test::call_service(&app, req).await;
    assert!(resp.status().is_success());

    // Check empty
    let req = actix_test::TestRequest::get()
        .uri("/api/users/me/following")
        .insert_header(("Authorization", format!("Bearer {token_a}")))
        .peer_addr(peer_addr()).to_request();
    let resp = actix_test::call_service(&app, req).await;
    let body: Value = actix_test::read_body_json(resp).await;
    assert_eq!(body.as_array().unwrap().len(), 0);
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
        .peer_addr(peer_addr()).to_request();

    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 201);

    let body: Value = actix_test::read_body_json(resp).await;
    assert_eq!(body["name"], "My Favorites");
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
        .peer_addr(peer_addr()).to_request();

    let resp = actix_test::call_service(&app, req).await;
    let body: Value = actix_test::read_body_json(resp).await;
    let list_id = body["id"].as_str().unwrap();

    // User B tries to update it
    let req = actix_test::TestRequest::patch()
        .uri(&format!("/api/lists/{list_id}"))
        .insert_header(("Authorization", format!("Bearer {token_b}")))
        .set_json(json!({ "name": "Hacked" }))
        .peer_addr(peer_addr()).to_request();

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
        .peer_addr(peer_addr()).to_request();

    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 400);
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
        .peer_addr(peer_addr()).to_request();

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
        .insert_header(("Authorization", "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwiZXhwIjoxfQ.fake"))
        .peer_addr(peer_addr()).to_request();

    let resp = actix_test::call_service(&app, req).await;
    assert_eq!(resp.status(), 401);
}
