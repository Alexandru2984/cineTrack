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
use crate::services::storage::StorageService;
use crate::services::{notifications, quota};
use crate::utils::password;

#[derive(sqlx::FromRow)]
struct ActivityRow {
    id: Uuid,
    user_id: Uuid,
    username: String,
    avatar_url: Option<String>,
    tmdb_id: i32,
    media_title: String,
    media_type: String,
    poster_path: Option<String>,
    episode_name: Option<String>,
    season_number: Option<i32>,
    episode_number: Option<i32>,
    timestamp: chrono::DateTime<chrono::Utc>,
}

#[derive(sqlx::FromRow)]
struct UserSearchRow {
    id: Uuid,
    username: String,
    avatar_url: Option<String>,
    bio: Option<String>,
    is_public: bool,
    followers_count: Option<i64>,
    follow_status: Option<String>,
}

impl From<UserSearchRow> for UserSearchResult {
    fn from(row: UserSearchRow) -> Self {
        Self {
            id: row.id,
            username: row.username,
            avatar_url: row.avatar_url,
            bio: row.bio,
            is_public: row.is_public,
            followers_count: row.followers_count,
            follow_status: row.follow_status,
        }
    }
}

impl From<ActivityRow> for ActivityItem {
    fn from(row: ActivityRow) -> Self {
        Self {
            id: row.id,
            user_id: row.user_id,
            username: row.username,
            avatar_url: row.avatar_url,
            action: "watched".to_string(),
            tmdb_id: row.tmdb_id,
            media_title: row.media_title,
            media_type: row.media_type,
            poster_path: row.poster_path,
            episode_name: row.episode_name,
            season_number: row.season_number,
            episode_number: row.episode_number,
            timestamp: row.timestamp,
        }
    }
}

#[derive(serde::Deserialize)]
struct ActivityFeedParams {
    limit: Option<u32>,
    before: Option<chrono::DateTime<chrono::Utc>>,
    before_id: Option<Uuid>,
}

impl ActivityFeedParams {
    fn limit(&self) -> i64 {
        self.limit.unwrap_or(20).clamp(1, 100) as i64
    }

    fn cursor(&self) -> Result<Option<(chrono::DateTime<chrono::Utc>, Uuid)>, AppError> {
        match (self.before, self.before_id) {
            (Some(timestamp), Some(id)) => Ok(Some((timestamp, id))),
            (None, None) => Ok(None),
            _ => Err(AppError::BadRequest(
                "Both before and before_id are required for activity pagination".to_string(),
            )),
        }
    }
}

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::scope("/users")
            .route("/me", web::patch().to(update_profile))
            .route("/me", web::delete().to(delete_account))
            .route("/me/followers", web::get().to(my_followers))
            .route("/me/following", web::get().to(my_following))
            .route("/me/feed", web::get().to(my_activity_feed))
            .route("/me/follow-requests", web::get().to(my_follow_requests))
            .route(
                "/me/follow-requests/{follower_id}/accept",
                web::post().to(accept_follow_request),
            )
            .route(
                "/me/follow-requests/{follower_id}",
                web::delete().to(reject_follow_request),
            )
            .route("/search", web::get().to(search_users))
            .route("/{username}", web::get().to(get_profile))
            .route("/{username}/activity", web::get().to(get_user_activity))
            .route("/{username}/follow", web::post().to(follow_user))
            .route("/{username}/follow", web::delete().to(unfollow_user)),
    );
}

fn escaped_prefix_pattern(fragment: &str) -> String {
    let mut pattern = String::with_capacity(fragment.len() + 1);
    for character in fragment.chars() {
        if matches!(character, '\\' | '%' | '_') {
            pattern.push('\\');
        }
        pattern.push(character.to_ascii_lowercase());
    }
    pattern.push('%');
    pattern
}

async fn search_users(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    params: web::Query<UserSearchParams>,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    params.validate()?;

    let query = params.q.trim().to_ascii_lowercase();
    let pattern = escaped_prefix_pattern(&query);
    let limit = params.limit_val();
    let mut rows = sqlx::query_as::<_, UserSearchRow>(
        r#"SELECT u.id, u.username,
            CASE
                WHEN u.is_public OR u.id = $1 OR relationship.status = 'accepted'
                THEN u.avatar_url
                ELSE NULL
            END AS avatar_url,
            CASE
                WHEN u.is_public OR u.id = $1 OR relationship.status = 'accepted'
                THEN u.bio
                ELSE NULL
            END AS bio,
            u.is_public,
            CASE
                WHEN u.is_public OR u.id = $1 OR relationship.status = 'accepted'
                THEN COALESCE(follower_count.total, 0)
                ELSE NULL
            END AS followers_count,
            relationship.status AS follow_status
        FROM users u
        LEFT JOIN follows relationship
            ON relationship.follower_id = $1
            AND relationship.following_id = u.id
        LEFT JOIN LATERAL (
            SELECT COUNT(*) AS total
            FROM follows follower
            WHERE follower.following_id = u.id AND follower.status = 'accepted'
        ) follower_count ON TRUE
        WHERE LOWER(u.username) LIKE $2 ESCAPE '\'
        ORDER BY (LOWER(u.username) = $3) DESC, LOWER(u.username), u.id
        LIMIT $4 OFFSET $5"#,
    )
    .bind(user_id)
    .bind(pattern)
    .bind(query)
    .bind(limit + 1)
    .bind(params.offset())
    .fetch_all(pool.get_ref())
    .await?;

    let has_more = rows.len() > limit as usize;
    rows.truncate(limit as usize);
    Ok(HttpResponse::Ok().json(UserSearchResponse {
        results: rows.into_iter().map(Into::into).collect(),
        page: params.page_val(),
        has_more,
    }))
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
        // Private profiles keep their follow graph size hidden from
        // unapproved viewers, consistent with bio/avatar/activity.
        followers_count: can_view_private_details.then_some(followers_count),
        following_count: can_view_private_details.then_some(following_count),
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

    if data.is_public == Some(true) {
        crate::services::auth::require_verified_email(pool.get_ref(), user_id).await?;
    }

    let mut tx = pool.begin().await?;
    let user = sqlx::query_as::<_, User>(
        r#"UPDATE users SET
            username = COALESCE($2, username),
            bio = COALESCE($3, bio),
            is_public = COALESCE($4, is_public),
            updated_at = NOW()
        WHERE id = $1 RETURNING *"#,
    )
    .bind(user_id)
    .bind(&data.username)
    .bind(&data.bio)
    .bind(data.is_public)
    .fetch_one(&mut *tx)
    .await?;

    if data.is_public == Some(true) {
        let accepted_followers = sqlx::query_scalar::<_, Uuid>(
            "UPDATE follows SET status = 'accepted', updated_at = NOW()
             WHERE following_id = $1 AND status = 'pending'
             RETURNING follower_id",
        )
        .bind(user_id)
        .fetch_all(&mut *tx)
        .await?;
        if !accepted_followers.is_empty() {
            notifications::remove_many(
                &mut tx,
                user_id,
                &accepted_followers,
                notifications::FOLLOW_REQUEST,
            )
            .await?;
            notifications::upsert_many(
                &mut tx,
                &accepted_followers,
                user_id,
                notifications::FOLLOW_ACCEPTED,
            )
            .await?;
            log::info!(
                "audit: accepted pending follow requests after profile became public user_id={user_id} count={}",
                accepted_followers.len()
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
    storage: web::Data<Option<StorageService>>,
    req: HttpRequest,
    body: web::Json<DeleteAccountRequest>,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    body.validate()?;

    let mut tx = pool.begin().await?;
    let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = $1 FOR UPDATE")
        .bind(user_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| AppError::NotFound("User not found".to_string()))?;

    let password_hash = user
        .password_hash
        .as_ref()
        .ok_or_else(|| AppError::BadRequest("Password login is not enabled".to_string()))?;

    if !password::verify_password(&body.password, password_hash).await? {
        return Err(AppError::Unauthorized("Password is incorrect".to_string()));
    }

    if let Some(store) = storage.get_ref() {
        store
            .delete_avatar_variants(user_id)
            .await
            .map_err(|error| {
                log::error!("account avatar cleanup failed user_id={user_id}: {error:#}");
                AppError::ServiceUnavailable(
                    "Stored account data could not be deleted. Try again later.".to_string(),
                )
            })?;
    } else if user.avatar_url.is_some() {
        return Err(AppError::ServiceUnavailable(
            "Stored account data could not be deleted. Try again later.".to_string(),
        ));
    }

    sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

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

    crate::services::auth::require_verified_email(pool.get_ref(), user_id).await?;

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
    quota::lock_social_relationship_writes(&mut tx, user_id, target.id).await?;

    let existing_status = sqlx::query_scalar::<_, String>(
        "SELECT status FROM follows WHERE follower_id = $1 AND following_id = $2",
    )
    .bind(user_id)
    .bind(target.id)
    .fetch_optional(&mut *tx)
    .await?;

    if existing_status.is_none() {
        let outgoing_count =
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM follows WHERE follower_id = $1")
                .bind(user_id)
                .fetch_one(&mut *tx)
                .await?;
        quota::ensure_social_relationship_capacity(outgoing_count, 1)?;

        if requested_status == "pending" {
            let pending_count = sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM follows WHERE following_id = $1 AND status = 'pending'",
            )
            .bind(target.id)
            .fetch_one(&mut *tx)
            .await?;
            quota::ensure_pending_follow_request_capacity(pending_count, 1)?;
        }
    }

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
    if existing_status.as_deref() != Some(status.as_str()) {
        if status == "pending" {
            notifications::upsert(&mut tx, target.id, user_id, notifications::FOLLOW_REQUEST)
                .await?;
        } else {
            notifications::remove(&mut tx, target.id, user_id, notifications::FOLLOW_REQUEST)
                .await?;
            notifications::upsert(&mut tx, target.id, user_id, notifications::NEW_FOLLOWER).await?;
        }
    }
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

    let mut tx = pool.begin().await?;
    let target = sqlx::query_as::<_, User>("SELECT * FROM users WHERE LOWER(username) = LOWER($1)")
        .bind(&username)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| AppError::NotFound("User not found".to_string()))?;
    quota::lock_social_relationship_writes(&mut tx, user_id, target.id).await?;

    let removed_status = sqlx::query_scalar::<_, String>(
        "DELETE FROM follows WHERE follower_id = $1 AND following_id = $2 RETURNING status",
    )
    .bind(user_id)
    .bind(target.id)
    .fetch_optional(&mut *tx)
    .await?;
    if removed_status.as_deref() == Some("pending") {
        notifications::remove(&mut tx, target.id, user_id, notifications::FOLLOW_REQUEST).await?;
    }
    tx.commit().await?;

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
        ORDER BY f.created_at DESC, f.follower_id
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
    crate::services::auth::require_verified_email(pool.get_ref(), user_id).await?;
    let mut tx = pool.begin().await?;
    quota::lock_social_relationship_writes(&mut tx, follower_id, user_id).await?;
    let updated = sqlx::query(
        "UPDATE follows SET status = 'accepted', updated_at = NOW()
         WHERE follower_id = $1 AND following_id = $2 AND status = 'pending'",
    )
    .bind(follower_id)
    .bind(user_id)
    .execute(&mut *tx)
    .await?
    .rows_affected();

    if updated == 0 {
        return Err(AppError::NotFound("Follow request not found".to_string()));
    }
    notifications::remove(&mut tx, user_id, follower_id, notifications::FOLLOW_REQUEST).await?;
    notifications::upsert(
        &mut tx,
        follower_id,
        user_id,
        notifications::FOLLOW_ACCEPTED,
    )
    .await?;
    tx.commit().await?;
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
    let mut tx = pool.begin().await?;
    quota::lock_social_relationship_writes(&mut tx, follower_id, user_id).await?;
    let deleted = sqlx::query(
        "DELETE FROM follows
         WHERE follower_id = $1 AND following_id = $2 AND status = 'pending'",
    )
    .bind(follower_id)
    .bind(user_id)
    .execute(&mut *tx)
    .await?
    .rows_affected();

    if deleted == 0 {
        return Err(AppError::NotFound("Follow request not found".to_string()));
    }
    notifications::remove(&mut tx, user_id, follower_id, notifications::FOLLOW_REQUEST).await?;
    tx.commit().await?;
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

    let followers = sqlx::query_as::<_, (Uuid, String, Option<String>, Option<String>)>(
        r#"SELECT u.id, u.username,
            CASE WHEN u.is_public OR reciprocal.follower_id IS NOT NULL THEN u.avatar_url ELSE NULL END,
            CASE WHEN u.is_public OR reciprocal.follower_id IS NOT NULL THEN u.bio ELSE NULL END
        FROM users u
        JOIN follows f ON u.id = f.follower_id
        LEFT JOIN follows reciprocal
            ON reciprocal.follower_id = $1
            AND reciprocal.following_id = u.id
            AND reciprocal.status = 'accepted'
        WHERE f.following_id = $1 AND f.status = 'accepted'
        ORDER BY f.created_at DESC, f.follower_id
        LIMIT $2 OFFSET $3"#,
    )
    .bind(user_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool.get_ref())
    .await?;

    let response: Vec<crate::dto::auth::UserSummary> = followers
        .into_iter()
        .map(
            |(id, username, avatar_url, bio)| crate::dto::auth::UserSummary {
                id,
                username,
                avatar_url,
                bio,
            },
        )
        .collect();
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
        r#"SELECT u.* FROM users u
        JOIN follows f ON u.id = f.following_id
        WHERE f.follower_id = $1 AND f.status = 'accepted'
        ORDER BY f.created_at DESC, f.following_id
        LIMIT $2 OFFSET $3"#,
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
    pagination: web::Query<PaginationParams>,
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

    let activities = sqlx::query_as::<_, ActivityRow>(
        r#"SELECT wh.id, wh.user_id, u.username, u.avatar_url, m.tmdb_id,
            m.title AS media_title, m.media_type, m.poster_path,
            e.name AS episode_name, s.season_number, e.episode_number,
            wh.watched_at AS timestamp
        FROM watch_history wh
        JOIN users u ON wh.user_id = u.id
        JOIN media m ON wh.media_id = m.id
        LEFT JOIN episodes e ON wh.episode_id = e.id
        LEFT JOIN seasons s ON e.season_id = s.id
        WHERE wh.user_id = $1
        ORDER BY wh.watched_at DESC, wh.id DESC
        LIMIT $2 OFFSET $3"#,
    )
    .bind(user.id)
    .bind(pagination.limit_val())
    .bind(pagination.offset())
    .fetch_all(pool.get_ref())
    .await?;

    let items: Vec<ActivityItem> = activities.into_iter().map(Into::into).collect();

    Ok(HttpResponse::Ok().json(items))
}

/// Returns the authenticated user's activity and activity from accounts they
/// currently follow. Pending requests never grant access to private activity.
async fn my_activity_feed(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    params: web::Query<ActivityFeedParams>,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    let limit = params.limit();
    let cursor = params.cursor()?;
    let (before, before_id) = cursor.unzip();

    // Limiting each visible account before the final merge keeps the amount of
    // history considered proportional to the requested page and follow count.
    let activities = sqlx::query_as::<_, ActivityRow>(
        r#"WITH visible_users AS (
            SELECT $1::uuid AS user_id
            UNION ALL
            SELECT following_id
            FROM follows
            WHERE follower_id = $1 AND status = 'accepted'
        )
        SELECT recent.id, recent.user_id, u.username, u.avatar_url, m.tmdb_id,
            m.title AS media_title, m.media_type, m.poster_path,
            e.name AS episode_name, s.season_number, e.episode_number,
            recent.watched_at AS timestamp
        FROM visible_users visible
        CROSS JOIN LATERAL (
            SELECT wh.id, wh.user_id, wh.media_id, wh.episode_id, wh.watched_at
            FROM watch_history wh
            WHERE wh.user_id = visible.user_id
              AND (
                $3::timestamptz IS NULL
                OR (wh.watched_at, wh.id) < ($3::timestamptz, $4::uuid)
              )
            ORDER BY wh.watched_at DESC, wh.id DESC
            LIMIT $2
        ) recent
        JOIN users u ON recent.user_id = u.id
        JOIN media m ON recent.media_id = m.id
        LEFT JOIN episodes e ON recent.episode_id = e.id
        LEFT JOIN seasons s ON e.season_id = s.id
        ORDER BY recent.watched_at DESC, recent.id DESC
        LIMIT $2"#,
    )
    .bind(user_id)
    .bind(limit)
    .bind(before)
    .bind(before_id)
    .fetch_all(pool.get_ref())
    .await?;

    let items: Vec<ActivityItem> = activities.into_iter().map(Into::into).collect();
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
