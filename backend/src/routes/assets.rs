use actix_multipart::Multipart;
use actix_web::{web, HttpRequest, HttpResponse};
use futures_util::StreamExt;
use sqlx::PgPool;
use uuid::Uuid;

use crate::config::Config;
use crate::errors::AppError;
use crate::middleware::auth::require_auth;
use crate::services::storage::StorageService;
use crate::services::tmdb::TmdbService;

const MAX_AVATAR_BYTES: usize = 3 * 1024 * 1024; // 3 MB
const MAX_POSTER_BYTES: usize = 15 * 1024 * 1024; // 15 MB
const MAX_AVATAR_DIMENSION: u32 = 4096;
const MAX_AVATAR_PIXELS: u64 = 16_000_000;
const MAX_POSTER_DIMENSION: u32 = 8192;
const MAX_POSTER_PIXELS: u64 = 40_000_000;
const AVATAR_EXTS: &[&str] = &["png", "jpg", "webp", "gif"];
/// TMDB image sizes the poster cache is allowed to fetch.
const POSTER_SIZES: &[&str] = &[
    "w45", "w92", "w154", "w185", "w300", "w342", "w500", "w780", "w1280", "original",
];
pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::resource("/users/me/avatar")
            .route(web::post().to(upload_avatar))
            .route(web::delete().to(delete_avatar)),
    )
    .service(web::resource("/assets/avatars/{file}").route(web::get().to(serve_avatar_asset)))
    .service(
        web::resource("/assets/posters/{size}/{file}").route(web::get().to(serve_cached_poster)),
    )
    .service(web::resource("/img/{size}/{file}").route(web::get().to(serve_poster)));
}

/// Validate a `{size}/{file}` poster spec: an allowed TMDB size, then one safe
/// image filename. Rejects traversal and anything that could redirect the fetch.
fn valid_poster_spec(spec: &str) -> bool {
    if spec.len() > 256 || spec.contains("..") || spec.contains("//") || spec.contains(':') {
        return false;
    }
    let Some((size, path)) = spec.split_once('/') else {
        return false;
    };
    if !POSTER_SIZES.contains(&size) || path.is_empty() || path.len() > 200 {
        return false;
    }
    let ok_ext = [".jpg", ".jpeg", ".png", ".webp"]
        .iter()
        .any(|e| path.to_ascii_lowercase().ends_with(e));
    ok_ext
        && path
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

fn valid_public_asset_key(key: &str) -> bool {
    if let Some(name) = key.strip_prefix("avatars/") {
        let Some((id, extension)) = name.rsplit_once('.') else {
            return false;
        };
        return !id.contains('/')
            && Uuid::parse_str(id).is_ok()
            && AVATAR_EXTS.contains(&extension);
    }
    key.strip_prefix("posters/").is_some_and(valid_poster_spec)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ImageInfo {
    extension: &'static str,
    content_type: &'static str,
    width: u32,
    height: u32,
}

fn declared_content_type(content_type: &str) -> Option<&'static str> {
    match content_type {
        "image/png" => Some("image/png"),
        "image/jpeg" | "image/jpg" => Some("image/jpeg"),
        "image/webp" => Some("image/webp"),
        "image/gif" => Some("image/gif"),
        _ => None,
    }
}

fn inspect_image(bytes: &[u8]) -> Option<ImageInfo> {
    if let Some((width, height)) = png_dimensions(bytes) {
        return Some(ImageInfo {
            extension: "png",
            content_type: "image/png",
            width,
            height,
        });
    }
    if let Some((width, height)) = jpeg_dimensions(bytes) {
        return Some(ImageInfo {
            extension: "jpg",
            content_type: "image/jpeg",
            width,
            height,
        });
    }
    if let Some((width, height)) = webp_dimensions(bytes) {
        return Some(ImageInfo {
            extension: "webp",
            content_type: "image/webp",
            width,
            height,
        });
    }
    if let Some((width, height)) = gif_dimensions(bytes) {
        return Some(ImageInfo {
            extension: "gif",
            content_type: "image/gif",
            width,
            height,
        });
    }
    None
}

fn png_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    const SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
    const IEND: &[u8; 12] = b"\0\0\0\0IEND\xaeB`\x82";
    if bytes.len() < 45
        || &bytes[..8] != SIGNATURE
        || &bytes[8..12] != b"\0\0\0\r"
        || &bytes[12..16] != b"IHDR"
        || &bytes[bytes.len() - 12..] != IEND
    {
        return None;
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
    let height = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
    nonzero_dimensions(width, height)
}

fn gif_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 14
        || (!bytes.starts_with(b"GIF87a") && !bytes.starts_with(b"GIF89a"))
        || bytes.last() != Some(&0x3b)
    {
        return None;
    }
    let width = u16::from_le_bytes(bytes[6..8].try_into().ok()?) as u32;
    let height = u16::from_le_bytes(bytes[8..10].try_into().ok()?) as u32;
    nonzero_dimensions(width, height)
}

fn jpeg_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 8 || !bytes.starts_with(&[0xff, 0xd8]) || !bytes.ends_with(&[0xff, 0xd9]) {
        return None;
    }

    let mut offset = 2;
    while offset + 1 < bytes.len() - 2 {
        if bytes[offset] != 0xff {
            offset += 1;
            continue;
        }
        while offset < bytes.len() && bytes[offset] == 0xff {
            offset += 1;
        }
        let marker = *bytes.get(offset)?;
        offset += 1;

        if marker == 0xd9 || marker == 0xda {
            break;
        }
        if marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
            continue;
        }

        let segment_len =
            u16::from_be_bytes(bytes.get(offset..offset + 2)?.try_into().ok()?) as usize;
        if segment_len < 2 || offset.checked_add(segment_len)? > bytes.len() {
            return None;
        }
        if matches!(
            marker,
            0xc0 | 0xc1
                | 0xc2
                | 0xc3
                | 0xc5
                | 0xc6
                | 0xc7
                | 0xc9
                | 0xca
                | 0xcb
                | 0xcd
                | 0xce
                | 0xcf
        ) {
            if segment_len < 7 {
                return None;
            }
            let height = u16::from_be_bytes(bytes[offset + 3..offset + 5].try_into().ok()?) as u32;
            let width = u16::from_be_bytes(bytes[offset + 5..offset + 7].try_into().ok()?) as u32;
            return nonzero_dimensions(width, height);
        }
        offset += segment_len;
    }
    None
}

fn webp_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 25 || !bytes.starts_with(b"RIFF") || &bytes[8..12] != b"WEBP" {
        return None;
    }
    let riff_size = u32::from_le_bytes(bytes[4..8].try_into().ok()?) as usize;
    if riff_size.checked_add(8)? != bytes.len() {
        return None;
    }

    match &bytes[12..16] {
        b"VP8X" if bytes.len() >= 30 => {
            let width = 1
                + u32::from(bytes[24])
                + (u32::from(bytes[25]) << 8)
                + (u32::from(bytes[26]) << 16);
            let height = 1
                + u32::from(bytes[27])
                + (u32::from(bytes[28]) << 8)
                + (u32::from(bytes[29]) << 16);
            nonzero_dimensions(width, height)
        }
        b"VP8L" if bytes.len() >= 25 && bytes[20] == 0x2f => {
            let bits = u32::from_le_bytes(bytes[21..25].try_into().ok()?);
            let width = (bits & 0x3fff) + 1;
            let height = ((bits >> 14) & 0x3fff) + 1;
            nonzero_dimensions(width, height)
        }
        b"VP8 " if bytes.len() >= 30 && bytes[23..26] == [0x9d, 0x01, 0x2a] => {
            let width = u16::from_le_bytes(bytes[26..28].try_into().ok()?) & 0x3fff;
            let height = u16::from_le_bytes(bytes[28..30].try_into().ok()?) & 0x3fff;
            nonzero_dimensions(u32::from(width), u32::from(height))
        }
        _ => None,
    }
}

fn nonzero_dimensions(width: u32, height: u32) -> Option<(u32, u32)> {
    (width > 0 && height > 0).then_some((width, height))
}

fn dimensions_within(info: ImageInfo, max_dimension: u32, max_pixels: u64) -> bool {
    info.width <= max_dimension
        && info.height <= max_dimension
        && u64::from(info.width) * u64::from(info.height) <= max_pixels
}

fn validate_avatar_image(bytes: &[u8], declared_type: &str) -> Result<ImageInfo, AppError> {
    let info = inspect_image(bytes)
        .ok_or_else(|| AppError::BadRequest("Avatar is not a valid supported image".to_string()))?;
    if info.content_type != declared_type {
        return Err(AppError::BadRequest(
            "Avatar contents do not match its content type".to_string(),
        ));
    }
    if !dimensions_within(info, MAX_AVATAR_DIMENSION, MAX_AVATAR_PIXELS) {
        return Err(AppError::BadRequest(
            "Avatar dimensions are too large".to_string(),
        ));
    }
    Ok(info)
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

    let mut data: Option<(Vec<u8>, &'static str)> = None;
    while let Some(item) = payload.next().await {
        let mut field = item.map_err(|_| AppError::BadRequest("Malformed upload".to_string()))?;
        let ct = field
            .content_type()
            .map(|m| m.essence_str().to_string())
            .unwrap_or_default();
        let Some(declared_type) = declared_content_type(&ct) else {
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
            data = Some((buf, declared_type));
            break;
        }
    }

    let (bytes, declared_type) =
        data.ok_or_else(|| AppError::BadRequest("No image uploaded".to_string()))?;
    let info = validate_avatar_image(&bytes, declared_type)?;

    let key = format!("avatars/{user_id}.{}", info.extension);
    // Drop any earlier avatar for this user in a different format (best-effort).
    for old in AVATAR_EXTS.iter().filter(|ext| **ext != info.extension) {
        let _ = store.delete(&format!("avatars/{user_id}.{old}")).await;
    }

    store
        .put(&key, &bytes, info.content_type)
        .await
        .map_err(AppError::from)?;

    let avatar_url = format!("{}?v={}", store.public_url(&key), Uuid::new_v4().simple());
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

async fn serve_stored_asset(
    storage: web::Data<Option<StorageService>>,
    key: String,
    max_bytes: usize,
    max_dimension: u32,
    max_pixels: u64,
) -> Result<HttpResponse, AppError> {
    if !valid_public_asset_key(&key) {
        return Err(AppError::NotFound("Asset not found".to_string()));
    }
    let store = storage_or_503(storage.get_ref())?;
    let bytes = store
        .get(&key, max_bytes)
        .await
        .map_err(AppError::from)?
        .ok_or_else(|| AppError::NotFound("Asset not found".to_string()))?;
    let info = inspect_image(&bytes)
        .filter(|info| dimensions_within(*info, max_dimension, max_pixels))
        .ok_or_else(|| AppError::NotFound("Asset not found".to_string()))?;

    Ok(HttpResponse::Ok()
        .content_type(info.content_type)
        .insert_header(("Cache-Control", "public, max-age=86400"))
        .body(bytes))
}

/// Public proxy for the exact avatar key shape generated by the uploader.
async fn serve_avatar_asset(
    storage: web::Data<Option<StorageService>>,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    serve_stored_asset(
        storage,
        format!("avatars/{}", path.into_inner()),
        MAX_AVATAR_BYTES,
        MAX_AVATAR_DIMENSION,
        MAX_AVATAR_PIXELS,
    )
    .await
}

/// Public proxy for the exact poster key shape generated by the image cache.
async fn serve_cached_poster(
    storage: web::Data<Option<StorageService>>,
    path: web::Path<(String, String)>,
) -> Result<HttpResponse, AppError> {
    let (size, file) = path.into_inner();
    serve_stored_asset(
        storage,
        format!("posters/{size}/{file}"),
        MAX_POSTER_BYTES,
        MAX_POSTER_DIMENSION,
        MAX_POSTER_PIXELS,
    )
    .await
}

/// Write-through cache for TMDB poster/backdrop images: serve from R2 if present,
/// otherwise fetch the image from TMDB, store it under `posters/`, and serve it.
async fn serve_poster(
    storage: web::Data<Option<StorageService>>,
    config: web::Data<Config>,
    tmdb: web::Data<TmdbService>,
    path: web::Path<(String, String)>,
) -> Result<HttpResponse, AppError> {
    let (size, file) = path.into_inner();
    let spec = format!("{size}/{file}");
    if !valid_poster_spec(&spec) {
        return Err(AppError::NotFound("Image not found".to_string()));
    }
    let store = storage_or_503(storage.get_ref())?;
    let key = format!("posters/{spec}");

    if let Some(bytes) = store
        .get(&key, MAX_POSTER_BYTES)
        .await
        .map_err(AppError::from)?
    {
        let info = inspect_image(&bytes)
            .filter(|info| dimensions_within(*info, MAX_POSTER_DIMENSION, MAX_POSTER_PIXELS))
            .ok_or_else(|| AppError::NotFound("Image not found".to_string()))?;
        return Ok(serve_image(bytes, info.content_type));
    }

    let bytes = tmdb
        .fetch_image(&config.tmdb_image_base_url, &spec, MAX_POSTER_BYTES)
        .await
        .map_err(|error| match error {
            AppError::NotFound(_) => AppError::NotFound("Image not found".to_string()),
            other => other,
        })?;
    let info = inspect_image(&bytes)
        .filter(|info| dimensions_within(*info, MAX_POSTER_DIMENSION, MAX_POSTER_PIXELS))
        .ok_or_else(|| AppError::TmdbError("Invalid image response".to_string()))?;
    if let Err(e) = store.put(&key, &bytes, info.content_type).await {
        log::warn!("poster cache put {key} failed: {e:#}");
    }
    Ok(serve_image(bytes, info.content_type))
}

fn serve_image(bytes: Vec<u8>, content_type: &str) -> HttpResponse {
    HttpResponse::Ok()
        .content_type(content_type)
        .insert_header(("Cache-Control", "public, max-age=604800"))
        .body(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes.extend_from_slice(&[8, 6, 0, 0, 0]);
        bytes.extend_from_slice(&[0, 0, 0, 0]);
        bytes.extend_from_slice(b"\0\0\0\0IEND\xaeB`\x82");
        bytes
    }

    #[test]
    fn inspects_supported_image_headers_and_dimensions() {
        let info = inspect_image(&png(320, 240)).unwrap();
        assert_eq!(info.content_type, "image/png");
        assert_eq!((info.width, info.height), (320, 240));

        let mut gif = b"GIF89a".to_vec();
        gif.extend_from_slice(&320_u16.to_le_bytes());
        gif.extend_from_slice(&240_u16.to_le_bytes());
        gif.extend_from_slice(&[0, 0, 0, 0x3b]);
        let info = inspect_image(&gif).unwrap();
        assert_eq!(info.content_type, "image/gif");
        assert_eq!((info.width, info.height), (320, 240));
    }

    #[test]
    fn rejects_mislabeled_or_truncated_avatar_files() {
        assert!(validate_avatar_image(b"<script>alert(1)</script>", "image/png").is_err());
        assert!(validate_avatar_image(&png(64, 64), "image/jpeg").is_err());

        let mut truncated = png(64, 64);
        truncated.truncate(24);
        assert!(validate_avatar_image(&truncated, "image/png").is_err());
    }

    #[test]
    fn rejects_avatar_pixel_bombs() {
        assert!(validate_avatar_image(&png(4096, 4096), "image/png").is_err());
        assert!(validate_avatar_image(&png(2000, 2000), "image/png").is_ok());
    }

    #[test]
    fn poster_specs_cannot_redirect_or_traverse() {
        assert!(valid_poster_spec("w500/safe_path.jpg"));
        assert!(!valid_poster_spec("w500/../../private.jpg"));
        assert!(!valid_poster_spec("w500/https://example.com/x.jpg"));
        assert!(!valid_poster_spec("w500/nested/path.jpg"));
        assert!(!valid_poster_spec("giant/safe.jpg"));
    }

    #[test]
    fn public_asset_keys_match_only_generated_objects() {
        assert!(valid_public_asset_key(
            "avatars/550e8400-e29b-41d4-a716-446655440000.webp"
        ));
        assert!(valid_public_asset_key("posters/w500/safe_path.jpg"));
        assert!(!valid_public_asset_key("avatars/not-a-uuid.png"));
        assert!(!valid_public_asset_key(
            "avatars/550e8400-e29b-41d4-a716-446655440000.svg"
        ));
        assert!(!valid_public_asset_key("posters/../../backups/dump.gz"));
        assert!(!valid_public_asset_key("backups/dump.gz"));
    }
}
