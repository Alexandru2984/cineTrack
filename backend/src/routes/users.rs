use actix_web::{web, HttpRequest, HttpResponse};
use sqlx::PgPool;
use uuid::Uuid;
use validator::Validate;

use crate::config::Config;
use crate::dto::common::PaginationParams;
use crate::dto::social::*;
use crate::dto::user::*;
use crate::errors::AppError;
use crate::middleware::auth::require_auth;
use crate::models::User;
use crate::utils::password;

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::scope("/users")
            .route("/me", web::patch().to(update_profile))
            .route("/me", web::delete().to(delete_account))
            .route("/me/followers", web::get().to(my_followers))
            .route("/me/following", web::get().to(my_following))
            .route("/{username}", web::get().to(get_profile))
            .route("/{username}/activity", web::get().to(get_user_activity))
            .route("/{username}/follow", web::post().to(follow_user))
            .route("/{username}/follow", web::delete().to(unfollow_user)),
    );
}

async fn get_profile(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let username = path.into_inner();
    let current_user_id = require_auth(&req).await.ok();

    let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE LOWER(username) = LOWER($1)")
        .bind(&username)
        .fetch_optional(pool.get_ref())
        .await?
        .ok_or_else(|| AppError::NotFound("User not found".to_string()))?;

    let followers_count =
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM follows WHERE following_id = $1")
            .bind(user.id)
            .fetch_one(pool.get_ref())
            .await?;

    let following_count =
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM follows WHERE follower_id = $1")
            .bind(user.id)
            .fetch_one(pool.get_ref())
            .await?;

    let is_following = if let Some(uid) = current_user_id {
        sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2)",
        )
        .bind(uid)
        .bind(user.id)
        .fetch_one(pool.get_ref())
        .await?
    } else {
        false
    };
    let can_view_private_details = user.is_public
        || current_user_id == Some(user.id)
        || (current_user_id.is_some() && is_following);

    Ok(HttpResponse::Ok().json(PublicUserProfile {
        id: user.id,
        username: user.username,
        avatar_url: if can_view_private_details {
            user.avatar_url
        } else {
            None
        },
        bio: if can_view_private_details {
            user.bio
        } else {
            None
        },
        is_public: user.is_public,
        followers_count,
        following_count,
        is_following,
        created_at: user.created_at,
    }))
}

async fn update_profile(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    body: web::Json<UpdateProfileRequest>,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    body.validate()?;
    let data = body.into_inner();

    let user = sqlx::query_as::<_, User>(
        r#"UPDATE users SET
            username = COALESCE($2, username),
            bio = COALESCE($3, bio),
            avatar_url = COALESCE($4, avatar_url),
            is_public = COALESCE($5, is_public),
            updated_at = NOW()
        WHERE id = $1 RETURNING *"#,
    )
    .bind(user_id)
    .bind(&data.username)
    .bind(&data.bio)
    .bind(&data.avatar_url)
    .bind(data.is_public)
    .fetch_one(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok().json(crate::dto::auth::UserResponse::from(user)))
}

/// Permanently delete the authenticated user's account. Requires re-entering
/// the password; all related rows are removed via ON DELETE CASCADE, and the
/// refresh cookie is cleared so the now-orphaned session ends cleanly.
async fn delete_account(
    pool: web::Data<PgPool>,
    config: web::Data<Config>,
    req: HttpRequest,
    body: web::Json<DeleteAccountRequest>,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    body.validate()?;

    let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(pool.get_ref())
        .await?
        .ok_or_else(|| AppError::NotFound("User not found".to_string()))?;

    let password_hash = user
        .password_hash
        .as_ref()
        .ok_or_else(|| AppError::BadRequest("Password login is not enabled".to_string()))?;

    if !password::verify_password(&body.password, password_hash).await? {
        return Err(AppError::Unauthorized("Password is incorrect".to_string()));
    }

    sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(user_id)
        .execute(pool.get_ref())
        .await?;

    log::info!("audit: account deleted user_id={user_id}");

    Ok(HttpResponse::Ok()
        .cookie(crate::routes::auth::clear_refresh_cookie(config.get_ref()))
        .json(serde_json::json!({"message": "Account deleted"})))
}

async fn follow_user(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    let username = path.into_inner();

    let target = sqlx::query_as::<_, User>("SELECT * FROM users WHERE LOWER(username) = LOWER($1)")
        .bind(&username)
        .fetch_optional(pool.get_ref())
        .await?
        .ok_or_else(|| AppError::NotFound("User not found".to_string()))?;

    if target.id == user_id {
        return Err(AppError::BadRequest("Cannot follow yourself".to_string()));
    }

    sqlx::query(
        "INSERT INTO follows (follower_id, following_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    )
    .bind(user_id)
    .bind(target.id)
    .execute(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({"message": "Followed successfully"})))
}

async fn unfollow_user(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    let username = path.into_inner();

    let target = sqlx::query_as::<_, User>("SELECT * FROM users WHERE LOWER(username) = LOWER($1)")
        .bind(&username)
        .fetch_optional(pool.get_ref())
        .await?
        .ok_or_else(|| AppError::NotFound("User not found".to_string()))?;

    sqlx::query("DELETE FROM follows WHERE follower_id = $1 AND following_id = $2")
        .bind(user_id)
        .bind(target.id)
        .execute(pool.get_ref())
        .await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({"message": "Unfollowed successfully"})))
}

async fn my_followers(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    pagination: web::Query<PaginationParams>,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    let limit = pagination.limit_val();
    let offset = pagination.offset();

    let followers = sqlx::query_as::<_, User>(
        "SELECT u.* FROM users u JOIN follows f ON u.id = f.follower_id WHERE f.following_id = $1 LIMIT $2 OFFSET $3"
    )
    .bind(user_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool.get_ref())
    .await?;

    let response: Vec<crate::dto::auth::UserSummary> =
        followers.into_iter().map(|u| u.into()).collect();
    Ok(HttpResponse::Ok().json(response))
}

async fn my_following(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    pagination: web::Query<PaginationParams>,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    let limit = pagination.limit_val();
    let offset = pagination.offset();

    let following = sqlx::query_as::<_, User>(
        "SELECT u.* FROM users u JOIN follows f ON u.id = f.following_id WHERE f.follower_id = $1 LIMIT $2 OFFSET $3"
    )
    .bind(user_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool.get_ref())
    .await?;

    let response: Vec<crate::dto::auth::UserSummary> =
        following.into_iter().map(|u| u.into()).collect();
    Ok(HttpResponse::Ok().json(response))
}

/// Returns user's recent watch activity. Respects is_public flag:
/// private users' activity is only visible to themselves or their followers.
async fn get_user_activity(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let username = path.into_inner();
    let current_user_id = require_auth(&req).await.ok();

    let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE LOWER(username) = LOWER($1)")
        .bind(&username)
        .fetch_optional(pool.get_ref())
        .await?
        .ok_or_else(|| AppError::NotFound("User not found".to_string()))?;

    if !can_view_private_user(pool.get_ref(), current_user_id, &user).await? {
        return Err(AppError::Forbidden(
            "This user's activity is private".to_string(),
        ));
    }

    let activities = sqlx::query_as::<_, (Uuid, Uuid, String, Option<String>, String, String, Option<String>, chrono::DateTime<chrono::Utc>)>(
        r#"SELECT wh.id, wh.user_id, u.username, u.avatar_url, m.title, m.media_type, m.poster_path, wh.watched_at
        FROM watch_history wh
        JOIN users u ON wh.user_id = u.id
        JOIN media m ON wh.media_id = m.id
        WHERE wh.user_id = $1
        ORDER BY wh.watched_at DESC
        LIMIT 50"#
    )
    .bind(user.id)
    .fetch_all(pool.get_ref())
    .await?;

    let items: Vec<ActivityItem> = activities
        .into_iter()
        .map(
            |(id, user_id, username, avatar_url, title, media_type, poster_path, timestamp)| {
                ActivityItem {
                    id,
                    user_id,
                    username,
                    avatar_url,
                    action: "watched".to_string(),
                    media_title: title,
                    media_type,
                    poster_path,
                    timestamp,
                }
            },
        )
        .collect();

    Ok(HttpResponse::Ok().json(items))
}

async fn can_view_private_user(
    pool: &PgPool,
    current_user_id: Option<Uuid>,
    user: &User,
) -> Result<bool, AppError> {
    if user.is_public {
        return Ok(true);
    }

    let Some(uid) = current_user_id else {
        return Ok(false);
    };

    if uid == user.id {
        return Ok(true);
    }

    let is_follower = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2)",
    )
    .bind(uid)
    .bind(user.id)
    .fetch_one(pool)
    .await?;

    Ok(is_follower)
}
