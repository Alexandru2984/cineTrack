use actix_multipart::Multipart;
use actix_web::{web, HttpRequest, HttpResponse};
use futures_util::StreamExt;
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::config::Config;
use crate::errors::AppError;
use crate::middleware::auth::require_auth;
use crate::middleware::rate_limit::{RateLimit, RateLimitConfig};
use crate::services::storage::{StorageService, AVATAR_EXTENSIONS};
use crate::services::tmdb::TmdbService;
use crate::utils::image_metadata;

pub type ImageGovernorConfig = RateLimitConfig;

/// Public images get a far more generous budget than the rest of the API.
/// A single page of cards requests dozens of posters at once; under the shared
/// API limit that burst was answered with 429s, which the user sees as posters
/// that never load. The images are public, immutable and cached for a week, so
/// a high ceiling here costs nothing.
pub fn build_image_rate_limiter() -> ImageGovernorConfig {
    RateLimitConfig::new(50, 300).expect("valid image rate limiter configuration")
}

const MAX_AVATAR_BYTES: usize = 3 * 1024 * 1024; // 3 MB
const MAX_POSTER_BYTES: usize = 15 * 1024 * 1024; // 15 MB
const MAX_AVATAR_DIMENSION: u32 = 4096;
const MAX_AVATAR_PIXELS: u64 = 16_000_000;
const MAX_POSTER_DIMENSION: u32 = 8192;
const MAX_POSTER_PIXELS: u64 = 40_000_000;
/// TMDB image sizes the poster cache is allowed to fetch.
const POSTER_SIZES: &[&str] = &[
    "w45", "w92", "w154", "w185", "w300", "w342", "w500", "w780", "w1280", "original",
];
/// Avatar upload and delete: authenticated writes, so they stay on the normal
/// API budget. Registered inside the shared `/api` scope.
pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::resource("/users/me/avatar")
            .route(web::post().to(upload_avatar))
            .route(web::delete().to(delete_avatar)),
    );
}

/// The public image routes without a limiter, for the dev/test entry point
/// (`routes::configure`) which applies no rate limiting at all. Keeps both
/// entry points serving the same paths.
pub fn configure_public_images_unlimited(cfg: &mut web::ServiceConfig) {
    cfg.service(web::scope("/api/img").route("/{size}/{file}", web::get().to(serve_poster)))
        .service(
            web::scope("/api/assets")
                .route("/avatars/{file}", web::get().to(serve_avatar_asset))
                .route("/posters/{size}/{file}", web::get().to(serve_cached_poster)),
        );
}

/// The public, cacheable image routes as their own top-level scopes carrying
/// the image limiter. Registered ahead of the `/api` scope in main so the more
/// specific `/api/img` and `/api/assets` prefixes match here first; everything
/// else falls through to `/api`. Kept as real prefixed scopes rather than an
/// empty nested scope, which silently swallows the path and 404s every route.
pub fn configure_public_images(cfg: &mut web::ServiceConfig, limiter: &ImageGovernorConfig) {
    cfg.service(
        web::scope("/api/img")
            .wrap(RateLimit::new(limiter))
            .route("/{size}/{file}", web::get().to(serve_poster)),
    )
    .service(
        web::scope("/api/assets")
            .wrap(RateLimit::new(limiter))
            .route("/avatars/{file}", web::get().to(serve_avatar_asset))
            .route("/posters/{size}/{file}", web::get().to(serve_cached_poster)),
    );
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
        let Some((stem, extension)) = name.rsplit_once('.') else {
            return false;
        };
        if !AVATAR_EXTENSIONS.contains(&extension) {
            return false;
        }
        // Two shapes. `{user}/{nonce}` is what uploads write now: the nonce
        // makes the object unguessable, which is what keeps a private profile's
        // avatar from being fetched by anyone who has seen the account's id.
        // `{user}` alone is what earlier uploads wrote and is still referenced
        // by rows nobody has replaced since.
        //
        // Both are parsed as UUIDs, so neither can carry a path segment out of
        // the prefix.
        return match stem.split_once('/') {
            Some((user, nonce)) => {
                Uuid::parse_str(user).is_ok()
                    && !nonce.contains('/')
                    && Uuid::parse_str(nonce).is_ok()
            }
            None => Uuid::parse_str(stem).is_ok(),
        };
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

/// Remove embedded metadata before the bytes reach public storage. Avatars are
/// served unauthenticated, so EXIF GPS coordinates in an uploaded photo would
/// otherwise be world-readable. The mobile client already re-encodes, but the
/// web client uploads the file as chosen and a direct API call skips both, so
/// this is the only place the guarantee holds for every caller.
///
/// Fails closed: an image whose container cannot be rewritten confidently, or
/// that no longer describes the same picture afterwards, is refused rather than
/// stored with metadata intact.
fn strip_avatar_metadata(bytes: &[u8], info: ImageInfo) -> Result<Vec<u8>, AppError> {
    let stripped = image_metadata::strip_metadata(bytes, info.extension)
        .ok_or_else(|| AppError::BadRequest("Avatar metadata could not be removed".to_string()))?;
    let rewritten = inspect_image(&stripped).filter(|rewritten| {
        rewritten.content_type == info.content_type
            && rewritten.width == info.width
            && rewritten.height == info.height
    });
    if rewritten.is_none() {
        return Err(AppError::BadRequest(
            "Avatar metadata could not be removed".to_string(),
        ));
    }
    Ok(stripped)
}

fn storage_or_503(storage: &Option<StorageService>) -> Result<&StorageService, AppError> {
    storage
        .as_ref()
        .ok_or_else(|| AppError::BadRequest("File storage is not configured".to_string()))
}

async fn lock_user(tx: &mut Transaction<'_, Postgres>, user_id: Uuid) -> Result<(), AppError> {
    let exists = sqlx::query_scalar::<_, Uuid>("SELECT id FROM users WHERE id = $1 FOR UPDATE")
        .bind(user_id)
        .fetch_optional(&mut **tx)
        .await?
        .is_some();
    if !exists {
        return Err(AppError::NotFound("User not found".to_string()));
    }
    Ok(())
}

fn avatar_storage_unavailable(operation: &str, user_id: Uuid, error: anyhow::Error) -> AppError {
    log::error!("avatar {operation} failed user_id={user_id}: {error:#}");
    AppError::ServiceUnavailable(
        "Avatar storage is temporarily unavailable. Try again later.".to_string(),
    )
}

async fn upload_avatar(
    pool: web::Data<PgPool>,
    storage: web::Data<Option<StorageService>>,
    req: HttpRequest,
    mut payload: Multipart,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    crate::services::legal::require_current_terms(pool.get_ref(), user_id).await?;
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
    let bytes = strip_avatar_metadata(&bytes, info)?;

    // A nonce per upload, for two reasons the audit found separately.
    //
    // Two uploads of different formats used to write `avatars/{id}.png` and
    // `avatars/{id}.jpg`, each then deleting "every other variant" — so the
    // first request's cleanup could delete the image the second had just made
    // current, leaving the row pointing at nothing.
    //
    // And the key was derivable from the account id, which is not hidden. A
    // profile that withholds `avatar_url` from a viewer it has not approved
    // still answered `/api/assets/avatars/{id}.jpg` to anyone who asked.
    // Guessing a v4 nonce is not a thing that happens.
    let key = format!(
        "avatars/{user_id}/{}.{}",
        Uuid::new_v4().simple(),
        info.extension
    );

    // Write the new image before anything else, and before any transaction is
    // open. Two things were wrong with doing this the other way round.
    //
    // The old variants were deleted *first*, so a `put` that then failed left
    // the member with no image at all while their row still pointed at a key
    // that had just been removed — a broken avatar produced by a failed upload
    // that changed nothing the member asked to change.
    //
    // And both calls ran inside the transaction, with `FOR UPDATE` held on the
    // member's row. That makes R2's latency into lock-queue latency: a slow
    // object store stalls every other write to that member.
    //
    // Ordered this way, a failed upload leaves everything exactly as it was.
    store
        .put(&key, &bytes, info.content_type)
        .await
        .map_err(|error| avatar_storage_unavailable("upload", user_id, error))?;

    let avatar_url = format!("{}?v={}", store.public_url(&key), Uuid::new_v4().simple());

    // The transaction now holds one statement, so the lock lives for a local
    // write rather than for two round trips to a third party.
    let mut tx = pool.begin().await?;
    lock_user(&mut tx, user_id).await?;
    // Read what this upload replaces while the row is locked, so the key that
    // gets cleaned up below is the one this request actually superseded — not
    // whatever a concurrent upload happens to have written by then.
    let superseded =
        sqlx::query_scalar::<_, Option<String>>("SELECT avatar_url FROM users WHERE id = $1")
            .bind(user_id)
            .fetch_one(&mut *tx)
            .await?;
    sqlx::query("UPDATE users SET avatar_url = $2, updated_at = NOW() WHERE id = $1")
        .bind(user_id)
        .bind(&avatar_url)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    // Only once the row points at the new image, and only the exact object this
    // upload replaced. Deleting "every other variant" was what let two
    // concurrent uploads remove each other's work.
    //
    // Failing here leaves one unreferenced object. That is the cost of a key
    // nothing else can collide with, and it is bounded: deleting the avatar or
    // the account removes everything under the member's prefix.
    if let Some(previous) = superseded
        .as_deref()
        .and_then(|url| store.key_from_public_url(url))
        .filter(|previous| previous != &key)
    {
        if let Err(error) = store.delete(&previous).await {
            log::warn!(
                "avatar replacement cleanup failed user_id={user_id} key={previous}: {error:#}; \
                 it is unreferenced and removed with the avatar or the account"
            );
        }
    }

    crate::metrics::record_product_action(crate::metrics::ProductAction::AvatarUploaded);
    Ok(HttpResponse::Ok().json(serde_json::json!({ "avatar_url": avatar_url })))
}

async fn delete_avatar(
    pool: web::Data<PgPool>,
    storage: web::Data<Option<StorageService>>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    let store = storage_or_503(storage.get_ref())?;

    // Removal goes the other way round from upload, deliberately.
    //
    // Here the object is the thing being removed, and it is publicly readable
    // at a guessable URL until it is gone. Clearing the column first and then
    // failing to delete would answer "removed" while the image stayed
    // downloadable — so the store is emptied first, and a failure is refused
    // with the member's avatar still intact and the request still retryable.
    //
    // What both paths share is that no transaction is open across the network
    // call. The lock is taken afterwards, for one local statement.
    store
        .delete_avatar_variants(user_id)
        .await
        .map_err(|error| avatar_storage_unavailable("delete", user_id, error))?;

    let mut tx = pool.begin().await?;
    lock_user(&mut tx, user_id).await?;
    sqlx::query("UPDATE users SET avatar_url = NULL, updated_at = NOW() WHERE id = $1")
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    crate::metrics::record_product_action(crate::metrics::ProductAction::AvatarRemoved);
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

    /// The body of one function in this file, by brace matching.
    ///
    /// The two tests below are about the *order* of calls, which no unit test
    /// can observe without a real object store and a real database. Reading the
    /// source is the honest way to pin an ordering constraint that has no
    /// runtime signal, and it is the constraint that matters: both defects
    /// these tests exist for were invisible until R2 misbehaved.
    fn body_of(function: &str) -> &'static str {
        const SOURCE: &str = include_str!("assets.rs");
        let start = SOURCE
            .find(&format!("async fn {function}("))
            .unwrap_or_else(|| panic!("{function} is gone from this file"));
        let open = SOURCE[start..].find(" {").expect("function has a body") + start;
        let mut depth = 0usize;
        for (offset, character) in SOURCE[open..].char_indices() {
            match character {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        return &SOURCE[open..open + offset];
                    }
                }
                _ => {}
            }
        }
        panic!("{function} has an unbalanced body");
    }

    /// Runs of whitespace collapsed to one space, so a search is about code
    /// rather than layout.
    ///
    /// The first version of these tests searched for `"store\n        .put("`
    /// — a pattern carrying the source's own indentation. rustfmt reflows the
    /// very lines being searched for, and the search would then quietly stop
    /// matching: the loop below used `if let Some(..)`, so a guard that no
    /// longer found anything would have passed while checking nothing. That is
    /// the exact failure these tests exist to prevent, so the pattern must not
    /// depend on formatting and a missing match must be an error.
    fn flattened(function: &str) -> String {
        body_of(function)
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    }

    /// Where a call appears, or a failure naming what is missing.
    fn position_of(body: &str, call: &str, function: &str) -> usize {
        body.find(call)
            .unwrap_or_else(|| panic!("{function} no longer calls {call}"))
    }

    /// Nothing touches R2 while a transaction is open.
    ///
    /// Both handlers used to call the object store between `begin` and
    /// `commit`, with `FOR UPDATE` held on the member's row, which turns R2's
    /// latency into lock-queue latency for every other write to that member.
    #[test]
    fn avatar_storage_is_never_called_inside_a_transaction() {
        for (function, calls) in [
            (
                "upload_avatar",
                ["store .put(", "store.delete(&previous)"].as_slice(),
            ),
            ("delete_avatar", ["delete_avatar_variants"].as_slice()),
        ] {
            let body = flattened(function);
            let begin = position_of(&body, "pool.begin()", function);
            let commit = position_of(&body, "tx.commit()", function);
            for call in calls {
                let at = position_of(&body, call, function);
                assert!(
                    at < begin || at > commit,
                    "{function} calls {call} between begin and commit"
                );
            }
        }
    }

    /// The new image is written before the old one is removed.
    ///
    /// Reversed, a `put` that fails after the delete leaves the member with no
    /// image at all while their row still points at a key that no longer
    /// exists — a broken avatar produced by an upload that failed.
    #[test]
    fn an_upload_writes_before_it_deletes() {
        let body = flattened("upload_avatar");
        let put = position_of(&body, "store .put(", "upload_avatar");
        let cleanup = position_of(&body, "store.delete(&previous)", "upload_avatar");
        let commit = position_of(&body, "tx.commit()", "upload_avatar");
        assert!(
            put < cleanup,
            "upload_avatar deletes the old variants before writing the new one"
        );
        assert!(
            commit < cleanup,
            "cleanup must follow the commit, so a failure cannot orphan the live avatar"
        );
    }

    /// The key an upload writes cannot be derived from the account id.
    ///
    /// M03. A profile withholds `avatar_url` from a viewer it has not approved,
    /// but the account id is not secret, and the object was keyed
    /// `avatars/{id}.{ext}` — so the bytes answered to anyone who asked for one
    /// of four extensions. Hiding a field in JSON is not access control over
    /// the object it names.
    #[test]
    fn avatar_keys_are_not_derivable_from_the_account_id() {
        let body = flattened("upload_avatar");
        assert!(
            body.contains("avatars/{user_id}/{}.{}") && body.contains("Uuid::new_v4()"),
            "upload_avatar no longer writes a per-upload nonce, so the object is \
             guessable from the account id again"
        );
    }

    /// An upload removes the object it replaced, and only that one.
    ///
    /// M02. Cleanup used to delete "every variant except the one I wrote", so
    /// two uploads of different formats raced: the first request's cleanup
    /// could remove the image the second had just made current, leaving the row
    /// pointing at nothing.
    #[test]
    fn cleanup_targets_the_superseded_object_only() {
        let body = flattened("upload_avatar");
        assert!(
            !body.contains("delete_other_avatar_variants"),
            "upload_avatar still deletes by extension, which lets two uploads \
             delete each other's object"
        );
        let read = position_of(&body, "SELECT avatar_url FROM users", "upload_avatar");
        let lock = position_of(&body, "lock_user(", "upload_avatar");
        let commit = position_of(&body, "tx.commit()", "upload_avatar");
        assert!(
            lock < read && read < commit,
            "the superseded key must be read under the row lock, or a concurrent \
             upload decides which object this request deletes"
        );
    }

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
    fn poster_specs_reject_encoded_and_alternate_traversals() {
        // The plain "../" case is covered above; these are the usual ways to
        // smuggle it past a naive substring check. All of them must fail on the
        // allowed-character rule, not by accident.
        for spec in [
            r"w500\..\..\private.jpg",   // backslash separators
            "w500/%2e%2e%2fprivate.jpg", // percent-encoded ../
            "w500/%2E%2E/private.jpg",   // mixed-case encoding
            "w500/..%2fprivate.jpg",     // half-encoded
            "w500/\0/private.jpg",       // null byte
            "w500/pri vate.jpg",         // space
            "w500/private.jpg?x=1",      // query suffix
            "w500/private.jpg#frag",     // fragment
            "w500/private.svg",          // disallowed extension
            "w500/private.jpg.svg",      // double extension
            "/w500/private.jpg",         // leading slash -> empty size
        ] {
            assert!(!valid_poster_spec(spec), "expected {spec:?} to be rejected");
        }
    }

    #[test]
    fn poster_spec_allows_a_bare_extension_name() {
        // "w500/.jpg" passes the filter: it is a legal (if odd) object name, not
        // a traversal. Nothing generates such a key, so the lookup just misses
        // and 404s. Recorded so the permissiveness is a known boundary.
        assert!(valid_poster_spec("w500/.jpg"));
    }

    #[test]
    fn poster_specs_accept_every_allowed_tmdb_size() {
        // A size dropping out of the allowlist would silently 404 real posters.
        for size in POSTER_SIZES {
            assert!(
                valid_poster_spec(&format!("{size}/poster.jpg")),
                "expected size {size} to be accepted"
            );
        }
    }

    #[test]
    fn avatar_keys_reject_traversal_in_the_uuid_position() {
        for key in [
            "avatars/../posters/w500/x.jpg",
            "avatars/../../backups/dump.gz",
            "avatars/550e8400-e29b-41d4-a716-446655440000", // no extension
            "avatars/550e8400-e29b-41d4-a716-446655440000.", // empty extension
            "avatars/",
            "avatars/.png",
        ] {
            assert!(
                !valid_public_asset_key(key),
                "expected {key:?} to be rejected"
            );
        }
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
