use actix_web::{web, HttpRequest, HttpResponse};
use sqlx::PgPool;
use uuid::Uuid;

use crate::dto::social::*;
use crate::errors::AppError;
use crate::middleware::auth::require_auth;

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::scope("/lists")
            .route("/me", web::get().to(my_lists))
            .route("", web::post().to(create_list))
            .route("/{id}", web::get().to(get_list))
            .route("/{id}", web::patch().to(update_list))
            .route("/{id}", web::delete().to(delete_list))
            .route("/{id}/items", web::post().to(add_item))
            .route("/{id}/items/{media_id}", web::delete().to(remove_item))
    );
}

async fn my_lists(
    pool: web::Data<PgPool>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;

    let lists = sqlx::query_as::<_, (Uuid, String, Option<String>, bool, i64, chrono::DateTime<chrono::Utc>)>(
        r#"SELECT l.id, l.name, l.description, l.is_public,
            (SELECT COUNT(*) FROM list_items li WHERE li.list_id = l.id) as item_count,
            l.created_at
        FROM lists l WHERE l.user_id = $1
        ORDER BY l.created_at DESC"#
    )
    .bind(user_id)
    .fetch_all(pool.get_ref())
    .await?;

    let response: Vec<ListResponse> = lists.into_iter().map(|(id, name, description, is_public, item_count, created_at)| {
        ListResponse { id, name, description, is_public, item_count, created_at }
    }).collect();

    Ok(HttpResponse::Ok().json(response))
}

async fn create_list(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    body: web::Json<CreateListRequest>,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    let data = body.into_inner();

    let list = sqlx::query_as::<_, crate::models::List>(
        r#"INSERT INTO lists (user_id, name, description, is_public)
        VALUES ($1, $2, $3, $4)
        RETURNING *"#
    )
    .bind(user_id)
    .bind(&data.name)
    .bind(&data.description)
    .bind(data.is_public.unwrap_or(true))
    .fetch_one(pool.get_ref())
    .await?;

    Ok(HttpResponse::Created().json(list))
}

async fn get_list(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<Uuid>,
) -> Result<HttpResponse, AppError> {
    let list_id = path.into_inner();

    let list = sqlx::query_as::<_, crate::models::List>(
        "SELECT * FROM lists WHERE id = $1"
    )
    .bind(list_id)
    .fetch_optional(pool.get_ref())
    .await?
    .ok_or_else(|| AppError::NotFound("List not found".to_string()))?;

    let items = sqlx::query_as::<_, crate::models::Media>(
        r#"SELECT m.* FROM media m
        JOIN list_items li ON m.id = li.media_id
        WHERE li.list_id = $1
        ORDER BY li.added_at DESC"#
    )
    .bind(list_id)
    .fetch_all(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "list": list,
        "items": items
    })))
}

async fn update_list(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<Uuid>,
    body: web::Json<UpdateListRequest>,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    let list_id = path.into_inner();
    let data = body.into_inner();

    let list = sqlx::query_as::<_, crate::models::List>(
        r#"UPDATE lists SET
            name = COALESCE($3, name),
            description = COALESCE($4, description),
            is_public = COALESCE($5, is_public)
        WHERE id = $1 AND user_id = $2
        RETURNING *"#
    )
    .bind(list_id)
    .bind(user_id)
    .bind(&data.name)
    .bind(&data.description)
    .bind(data.is_public)
    .fetch_optional(pool.get_ref())
    .await?
    .ok_or_else(|| AppError::NotFound("List not found".to_string()))?;

    Ok(HttpResponse::Ok().json(list))
}

async fn delete_list(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<Uuid>,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    let list_id = path.into_inner();

    let result = sqlx::query("DELETE FROM lists WHERE id = $1 AND user_id = $2")
        .bind(list_id)
        .bind(user_id)
        .execute(pool.get_ref())
        .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("List not found".to_string()));
    }

    Ok(HttpResponse::Ok().json(serde_json::json!({"message": "Deleted"})))
}

async fn add_item(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<Uuid>,
    body: web::Json<AddListItemRequest>,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    let list_id = path.into_inner();

    // Verify list ownership
    let _list = sqlx::query_as::<_, crate::models::List>(
        "SELECT * FROM lists WHERE id = $1 AND user_id = $2"
    )
    .bind(list_id)
    .bind(user_id)
    .fetch_optional(pool.get_ref())
    .await?
    .ok_or_else(|| AppError::NotFound("List not found".to_string()))?;

    sqlx::query(
        "INSERT INTO list_items (list_id, media_id) VALUES ($1, $2) ON CONFLICT DO NOTHING"
    )
    .bind(list_id)
    .bind(body.media_id)
    .execute(pool.get_ref())
    .await?;

    Ok(HttpResponse::Created().json(serde_json::json!({"message": "Item added"})))
}

async fn remove_item(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<(Uuid, Uuid)>,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    let (list_id, media_id) = path.into_inner();

    // Verify ownership
    let _list = sqlx::query_as::<_, crate::models::List>(
        "SELECT * FROM lists WHERE id = $1 AND user_id = $2"
    )
    .bind(list_id)
    .bind(user_id)
    .fetch_optional(pool.get_ref())
    .await?
    .ok_or_else(|| AppError::NotFound("List not found".to_string()))?;

    sqlx::query("DELETE FROM list_items WHERE list_id = $1 AND media_id = $2")
        .bind(list_id)
        .bind(media_id)
        .execute(pool.get_ref())
        .await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({"message": "Item removed"})))
}
