use actix_multipart::Multipart;
use actix_web::{web, HttpRequest, HttpResponse};
use futures_util::StreamExt;
use sqlx::PgPool;

use crate::config::Config;
use crate::errors::AppError;
use crate::middleware::auth::require_auth;
use crate::services::storage::StorageService;

const MAX_AVATAR_BYTES: usize = 3 * 1024 * 1024; // 3 MB
const AVATAR_EXTS: &[&str] = &["png", "jpg", "webp", "gif"];
/// TMDB image sizes the poster cache is allowed to fetch.
const POSTER_SIZES: &[&str] = &[
    "w45", "w92", "w154", "w185", "w300", "w342", "w500", "w780", "w1280", "original",
];
/// Prefixes the public asset proxy is allowed to serve. Private objects
/// (imports/, backups/) live in the same bucket and must never be reachable here.
const PUBLIC_PREFIXES: &[&str] = &["avatars/", "posters/"];

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::resource("/users/me/avatar")
            .route(web::post().to(upload_avatar))
            .route(web::delete().to(delete_avatar)),
    )
    .service(web::resource("/assets/{key:.*}").route(web::get().to(serve_asset)))
    .service(web::resource("/img/{spec:.*}").route(web::get().to(serve_poster)));
}

/// Validate a `{size}/{path}` poster spec: an allowed TMDB size, then a safe
/// image path. Rejects traversal and anything that could redirect the fetch.
fn valid_poster_spec(spec: &str) -> bool {
    if spec.contains("..") || spec.contains("//") || spec.contains(':') {
        return false;
    }
    let Some((size, path)) = spec.split_once('/') else {
        return false;
    };
    if !POSTER_SIZES.contains(&size) || path.is_empty() {
        return false;
    }
    let ok_ext = [".jpg", ".jpeg", ".png", ".webp"]
        .iter()
        .any(|e| path.to_ascii_lowercase().ends_with(e));
    ok_ext
        && path
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '/'))
}

fn ext_and_type(content_type: &str) -> Option<(&'static str, &'static str)> {
    match content_type {
        "image/png" => Some(("png", "image/png")),
        "image/jpeg" | "image/jpg" => Some(("jpg", "image/jpeg")),
        "image/webp" => Some(("webp", "image/webp")),
        "image/gif" => Some(("gif", "image/gif")),
        _ => None,
    }
}

fn type_from_ext(key: &str) -> &'static str {
    match key.rsplit('.').next() {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        _ => "application/octet-stream",
    }
}

fn storage_or_503(storage: &Option<StorageService>) -> Result<&StorageService, AppError> {
    storage
        .as_ref()
        .ok_or_else(|| AppError::BadRequest("File storage is not configured".to_string()))
}

async fn upload_avatar(
    pool: web::Data<PgPool>,
    storage: web::Data<Option<StorageService>>,
    req: HttpRequest,
    mut payload: Multipart,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    let store = storage_or_503(storage.get_ref())?;

    let mut data: Option<(Vec<u8>, &'static str, &'static str)> = None; // (bytes, ext, content_type)
    while let Some(item) = payload.next().await {
        let mut field = item.map_err(|_| AppError::BadRequest("Malformed upload".to_string()))?;
        let ct = field
            .content_type()
            .map(|m| m.essence_str().to_string())
            .unwrap_or_default();
        let Some((ext, norm_ct)) = ext_and_type(&ct) else {
            return Err(AppError::BadRequest(
                "Avatar must be a PNG, JPEG, WebP or GIF image".to_string(),
            ));
        };
        let mut buf = Vec::new();
        while let Some(chunk) = field.next().await {
            let b = chunk.map_err(|_| AppError::BadRequest("Upload read error".to_string()))?;
            if buf.len() + b.len() > MAX_AVATAR_BYTES {
                return Err(AppError::BadRequest(
                    "Avatar image must be 3 MB or smaller".to_string(),
                ));
            }
            buf.extend_from_slice(&b);
        }
        if !buf.is_empty() {
            data = Some((buf, ext, norm_ct));
            break;
        }
    }

    let (bytes, ext, content_type) =
        data.ok_or_else(|| AppError::BadRequest("No image uploaded".to_string()))?;

    let key = format!("avatars/{user_id}.{ext}");
    // Drop any earlier avatar for this user in a different format (best-effort).
    for old in AVATAR_EXTS.iter().filter(|e| **e != ext) {
        let _ = store.delete(&format!("avatars/{user_id}.{old}")).await;
    }

    store
        .put(&key, &bytes, content_type)
        .await
        .map_err(AppError::from)?;

    let avatar_url = store.public_url(&key);
    sqlx::query("UPDATE users SET avatar_url = $2, updated_at = NOW() WHERE id = $1")
        .bind(user_id)
        .bind(&avatar_url)
        .execute(pool.get_ref())
        .await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({ "avatar_url": avatar_url })))
}

async fn delete_avatar(
    pool: web::Data<PgPool>,
    storage: web::Data<Option<StorageService>>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    let store = storage_or_503(storage.get_ref())?;

    for ext in AVATAR_EXTS {
        if let Err(e) = store.delete(&format!("avatars/{user_id}.{ext}")).await {
            log::warn!("avatar delete {user_id}.{ext}: {e:#}");
        }
    }
    sqlx::query("UPDATE users SET avatar_url = NULL, updated_at = NOW() WHERE id = $1")
        .bind(user_id)
        .execute(pool.get_ref())
        .await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "message": "Avatar removed" })))
}

/// Public, unauthenticated proxy for objects under the whitelisted prefixes.
async fn serve_asset(
    storage: web::Data<Option<StorageService>>,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let key = path.into_inner();
    if key.contains("..") || !PUBLIC_PREFIXES.iter().any(|p| key.starts_with(p)) {
        return Err(AppError::NotFound("Asset not found".to_string()));
    }
    let store = storage_or_503(storage.get_ref())?;
    let bytes = store
        .get(&key)
        .await
        .map_err(AppError::from)?
        .ok_or_else(|| AppError::NotFound("Asset not found".to_string()))?;

    Ok(HttpResponse::Ok()
        .content_type(type_from_ext(&key))
        .insert_header(("Cache-Control", "public, max-age=86400"))
        .body(bytes))
}

/// Write-through cache for TMDB poster/backdrop images: serve from R2 if present,
/// otherwise fetch the image from TMDB, store it under `posters/`, and serve it.
async fn serve_poster(
    storage: web::Data<Option<StorageService>>,
    config: web::Data<Config>,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let spec = path.into_inner();
    if !valid_poster_spec(&spec) {
        return Err(AppError::NotFound("Image not found".to_string()));
    }
    let store = storage_or_503(storage.get_ref())?;
    let key = format!("posters/{spec}");
    let content_type = type_from_ext(&spec);

    if let Some(bytes) = store.get(&key).await.map_err(AppError::from)? {
        return Ok(serve_image(bytes, content_type));
    }

    // Cache miss: fetch from TMDB's public image CDN and store it.
    let url = format!("{}/{}", config.tmdb_image_base_url.trim_end_matches('/'), spec);
    let resp = reqwest::get(&url)
        .await
        .map_err(|_| AppError::TmdbError("image fetch failed".to_string()))?;
    if !resp.status().is_success() {
        return Err(AppError::NotFound("Image not found".to_string()));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|_| AppError::TmdbError("image read failed".to_string()))?
        .to_vec();
    if let Err(e) = store.put(&key, &bytes, content_type).await {
        log::warn!("poster cache put {key} failed: {e:#}");
    }
    Ok(serve_image(bytes, content_type))
}

fn serve_image(bytes: Vec<u8>, content_type: &str) -> HttpResponse {
    HttpResponse::Ok()
        .content_type(content_type)
        .insert_header(("Cache-Control", "public, max-age=604800"))
        .body(bytes)
}
