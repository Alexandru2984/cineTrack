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
            .route("/me/follow-requests", web::get().to(my_follow_requests))
            .route(
                "/me/follow-requests/{follower_id}/accept",
                web::post().to(accept_follow_request),
            )
            .route(
                "/me/follow-requests/{follower_id}",
                web::delete().to(reject_follow_request),
            )
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

    let followers_count = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM follows WHERE following_id = $1 AND status = 'accepted'",
    )
    .bind(user.id)
    .fetch_one(pool.get_ref())
    .await?;

    let following_count = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM follows WHERE follower_id = $1 AND status = 'accepted'",
    )
    .bind(user.id)
    .fetch_one(pool.get_ref())
    .await?;

    let follow_status = if let Some(uid) = current_user_id.filter(|uid| *uid != user.id) {
        sqlx::query_scalar::<_, String>(
            "SELECT status FROM follows WHERE follower_id = $1 AND following_id = $2",
        )
        .bind(uid)
        .bind(user.id)
        .fetch_optional(pool.get_ref())
        .await?
    } else {
        None
    };
    let is_following = follow_status.as_deref() == Some("accepted");
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
        follow_status,
        can_view_activity: can_view_private_details,
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

    let mut tx = pool.begin().await?;
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
    .fetch_one(&mut *tx)
    .await?;

    if data.is_public == Some(true) {
        let accepted = sqlx::query(
            "UPDATE follows SET status = 'accepted', updated_at = NOW()
             WHERE following_id = $1 AND status = 'pending'",
        )
        .bind(user_id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        if accepted > 0 {
            log::info!(
                "audit: accepted pending follow requests after profile became public user_id={user_id} count={accepted}"
            );
        }
    }
    tx.commit().await?;

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

    let mut tx = pool.begin().await?;
    let target = sqlx::query_as::<_, User>(
        "SELECT * FROM users WHERE LOWER(username) = LOWER($1) FOR SHARE",
    )
    .bind(&username)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::NotFound("User not found".to_string()))?;

    if target.id == user_id {
        return Err(AppError::BadRequest("Cannot follow yourself".to_string()));
    }

    let requested_status = if target.is_public {
        "accepted"
    } else {
        "pending"
    };
    let status = sqlx::query_scalar::<_, String>(
        r#"INSERT INTO follows (follower_id, following_id, status)
        VALUES ($1, $2, $3)
        ON CONFLICT (follower_id, following_id) DO UPDATE SET
            status = CASE
                WHEN follows.status = 'accepted' THEN 'accepted'
                ELSE EXCLUDED.status
            END,
            updated_at = NOW()
        RETURNING status"#,
    )
    .bind(user_id)
    .bind(target.id)
    .bind(requested_status)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;

    log::info!(
        "audit: follow relationship requested follower_id={user_id} following_id={} status={status}",
        target.id
    );
    let is_pending = status == "pending";
    let body = serde_json::json!({
        "message": if is_pending { "Follow request sent" } else { "Followed successfully" },
        "status": status,
    });
    if is_pending {
        Ok(HttpResponse::Accepted().json(body))
    } else {
        Ok(HttpResponse::Ok().json(body))
    }
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

    let removed_status = sqlx::query_scalar::<_, String>(
        "DELETE FROM follows WHERE follower_id = $1 AND following_id = $2 RETURNING status",
    )
    .bind(user_id)
    .bind(target.id)
    .fetch_optional(pool.get_ref())
    .await?;

    let message = if removed_status.as_deref() == Some("pending") {
        "Follow request canceled"
    } else {
        "Unfollowed successfully"
    };
    Ok(HttpResponse::Ok().json(serde_json::json!({"message": message})))
}

async fn my_follow_requests(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    pagination: web::Query<PaginationParams>,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    let requests =
        sqlx::query_as::<_, (Uuid, String, Option<String>, chrono::DateTime<chrono::Utc>)>(
            r#"SELECT u.id, u.username,
            CASE WHEN u.is_public THEN u.avatar_url ELSE NULL END,
            f.created_at
        FROM follows f
        JOIN users u ON u.id = f.follower_id
        WHERE f.following_id = $1 AND f.status = 'pending'
        ORDER BY f.created_at DESC
        LIMIT $2 OFFSET $3"#,
        )
        .bind(user_id)
        .bind(pagination.limit_val())
        .bind(pagination.offset())
        .fetch_all(pool.get_ref())
        .await?;

    let response: Vec<FollowRequestResponse> = requests
        .into_iter()
        .map(
            |(user_id, username, avatar_url, requested_at)| FollowRequestResponse {
                user_id,
                username,
                avatar_url,
                requested_at,
            },
        )
        .collect();
    Ok(HttpResponse::Ok().json(response))
}

async fn accept_follow_request(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<Uuid>,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    let follower_id = path.into_inner();
    let updated = sqlx::query(
        "UPDATE follows SET status = 'accepted', updated_at = NOW()
         WHERE follower_id = $1 AND following_id = $2 AND status = 'pending'",
    )
    .bind(follower_id)
    .bind(user_id)
    .execute(pool.get_ref())
    .await?
    .rows_affected();

    if updated == 0 {
        return Err(AppError::NotFound("Follow request not found".to_string()));
    }
    log::info!("audit: follow request accepted follower_id={follower_id} following_id={user_id}");
    Ok(HttpResponse::Ok().json(serde_json::json!({"message": "Follow request accepted"})))
}

async fn reject_follow_request(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<Uuid>,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    let follower_id = path.into_inner();
    let deleted = sqlx::query(
        "DELETE FROM follows
         WHERE follower_id = $1 AND following_id = $2 AND status = 'pending'",
    )
    .bind(follower_id)
    .bind(user_id)
    .execute(pool.get_ref())
    .await?
    .rows_affected();

    if deleted == 0 {
        return Err(AppError::NotFound("Follow request not found".to_string()));
    }
    log::info!("audit: follow request rejected follower_id={follower_id} following_id={user_id}");
    Ok(HttpResponse::Ok().json(serde_json::json!({"message": "Follow request rejected"})))
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
        "SELECT u.* FROM users u JOIN follows f ON u.id = f.follower_id WHERE f.following_id = $1 AND f.status = 'accepted' LIMIT $2 OFFSET $3"
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
        "SELECT u.* FROM users u JOIN follows f ON u.id = f.following_id WHERE f.follower_id = $1 AND f.status = 'accepted' LIMIT $2 OFFSET $3"
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
        "SELECT EXISTS(SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2 AND status = 'accepted')",
    )
    .bind(uid)
    .bind(user.id)
    .fetch_one(pool)
    .await?;

    Ok(is_follower)
}
