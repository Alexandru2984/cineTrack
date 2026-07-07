use actix_multipart::Multipart;
use actix_web::{web, HttpRequest, HttpResponse};
use futures_util::StreamExt;
use sqlx::PgPool;
use uuid::Uuid;

use crate::config::Config;
use crate::dto::import::*;
use crate::errors::AppError;
use crate::middleware::auth::require_auth;
use crate::services::importer;
use crate::services::tmdb::TmdbService;

/// Max size accepted for any single uploaded export file.
const MAX_FILE_BYTES: usize = 32 * 1024 * 1024;

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::scope("/import")
            .route("/tvtime", web::post().to(start_import))
            .route("/jobs", web::get().to(list_jobs))
            .route("/jobs/{id}", web::get().to(get_job)),
    );
}

async fn read_field(field: &mut actix_multipart::Field) -> Result<Vec<u8>, AppError> {
    let mut buf = Vec::new();
    while let Some(chunk) = field.next().await {
        let data = chunk.map_err(|_| AppError::BadRequest("Upload read error".to_string()))?;
        if buf.len() + data.len() > MAX_FILE_BYTES {
            return Err(AppError::BadRequest(
                "Uploaded file is too large".to_string(),
            ));
        }
        buf.extend_from_slice(&data);
    }
    Ok(buf)
}

/// Parse the TV Time GDPR `rewatched_episode.csv` (unquoted, comma-separated).
/// Best-effort: unknown/short rows are skipped.
fn parse_rewatches(bytes: &[u8]) -> Vec<RewatchRow> {
    let text = String::from_utf8_lossy(bytes);
    let mut lines = text.lines();
    let Some(header) = lines.next() else {
        return Vec::new();
    };
    let cols: Vec<&str> = header.split(',').map(|c| c.trim()).collect();
    let idx = |name: &str| cols.iter().position(|c| *c == name);
    let (Some(i_name), Some(i_season), Some(i_ep), Some(i_created)) = (
        idx("tv_show_name"),
        idx("episode_season_number"),
        idx("episode_number"),
        idx("created_at"),
    ) else {
        return Vec::new();
    };
    let max_idx = i_name.max(i_season).max(i_ep).max(i_created);

    let mut out = Vec::new();
    for line in lines {
        let f: Vec<&str> = line.split(',').collect();
        if f.len() <= max_idx {
            continue;
        }
        let (Ok(season), Ok(episode)) =
            (f[i_season].trim().parse::<i32>(), f[i_ep].trim().parse::<i32>())
        else {
            continue;
        };
        out.push(RewatchRow {
            show_name: f[i_name].trim().to_string(),
            season_number: season,
            episode_number: episode,
            created_at: f[i_created].trim().to_string(),
        });
    }
    out
}

async fn start_import(
    pool: web::Data<PgPool>,
    tmdb: web::Data<TmdbService>,
    config: web::Data<Config>,
    req: HttpRequest,
    mut payload: Multipart,
) -> Result<HttpResponse, AppError> {
    let _ = config; // reserved for future per-user limits
    let user_id = require_auth(&req).await?;

    // One completed import per user keeps the data clean and avoids duplicate
    // watch_history rows from a double submit.
    let already = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM import_jobs WHERE user_id = $1 AND status IN ('pending','running','completed'))",
    )
    .bind(user_id)
    .fetch_one(pool.get_ref())
    .await?;
    if already {
        return Err(AppError::Conflict(
            "An import already exists for this account".to_string(),
        ));
    }

    let mut shows_bytes: Option<Vec<u8>> = None;
    let mut movies_bytes: Option<Vec<u8>> = None;
    let mut rewatch_bytes: Option<Vec<u8>> = None;

    while let Some(item) = payload.next().await {
        let mut field = item.map_err(|_| AppError::BadRequest("Malformed upload".to_string()))?;
        let name = field
            .content_disposition()
            .and_then(|cd| cd.get_name())
            .unwrap_or("")
            .to_string();
        let bytes = read_field(&mut field).await?;
        match name.as_str() {
            "shows" => shows_bytes = Some(bytes),
            "movies" => movies_bytes = Some(bytes),
            "rewatches" => rewatch_bytes = Some(bytes),
            _ => {}
        }
    }

    let shows: Vec<TvTimeShow> = match &shows_bytes {
        Some(b) if !b.is_empty() => serde_json::from_slice(b)
            .map_err(|_| AppError::BadRequest("Invalid shows.json".to_string()))?,
        _ => Vec::new(),
    };
    let movies: Vec<TvTimeMovie> = match &movies_bytes {
        Some(b) if !b.is_empty() => serde_json::from_slice(b)
            .map_err(|_| AppError::BadRequest("Invalid movies.json".to_string()))?,
        _ => Vec::new(),
    };
    let rewatches = rewatch_bytes.as_deref().map(parse_rewatches).unwrap_or_default();

    if shows.is_empty() && movies.is_empty() {
        return Err(AppError::BadRequest(
            "Upload at least shows.json or movies.json".to_string(),
        ));
    }

    let job_id: Uuid = sqlx::query_scalar(
        "INSERT INTO import_jobs (user_id, status) VALUES ($1, 'pending') RETURNING id",
    )
    .bind(user_id)
    .fetch_one(pool.get_ref())
    .await?;

    let pool_c = pool.get_ref().clone();
    let tmdb_c = tmdb.get_ref().clone();
    actix_web::rt::spawn(async move {
        importer::run_import(pool_c, tmdb_c, job_id, user_id, shows, movies, rewatches).await;
    });

    Ok(HttpResponse::Accepted().json(serde_json::json!({ "job_id": job_id })))
}

async fn get_job(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<Uuid>,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    let job_id = path.into_inner();

    let job = sqlx::query_as::<_, (Uuid, String, Option<serde_json::Value>, Option<String>, chrono::DateTime<chrono::Utc>, chrono::DateTime<chrono::Utc>)>(
        "SELECT id, status, totals, error, created_at, updated_at FROM import_jobs WHERE id = $1 AND user_id = $2",
    )
    .bind(job_id)
    .bind(user_id)
    .fetch_optional(pool.get_ref())
    .await?
    .ok_or_else(|| AppError::NotFound("Import job not found".to_string()))?;

    Ok(HttpResponse::Ok().json(ImportJobResponse {
        id: job.0,
        status: job.1,
        totals: job.2,
        error: job.3,
        created_at: job.4,
        updated_at: job.5,
    }))
}

async fn list_jobs(
    pool: web::Data<PgPool>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    let rows = sqlx::query_as::<_, (Uuid, String, Option<serde_json::Value>, Option<String>, chrono::DateTime<chrono::Utc>, chrono::DateTime<chrono::Utc>)>(
        "SELECT id, status, totals, error, created_at, updated_at FROM import_jobs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20",
    )
    .bind(user_id)
    .fetch_all(pool.get_ref())
    .await?;

    let jobs: Vec<ImportJobResponse> = rows
        .into_iter()
        .map(|j| ImportJobResponse {
            id: j.0,
            status: j.1,
            totals: j.2,
            error: j.3,
            created_at: j.4,
            updated_at: j.5,
        })
        .collect();
    Ok(HttpResponse::Ok().json(jobs))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_rewatches_reads_known_columns() {
        let csv = "user_id,episode_id,cpt,created_at,updated_at,tv_show_name,episode_season_number,episode_number\n\
                   11472396,297892,1,2018-12-25 00:18:11,2018-12-25 00:18:11,Prison Break,1,2\n\
                   11472396,306139,1,2018-12-25 00:18:11,2018-12-25 00:18:11,Tokyo Ghoul,2,5\n";
        let rows = parse_rewatches(csv.as_bytes());
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].show_name, "Prison Break");
        assert_eq!(rows[0].season_number, 1);
        assert_eq!(rows[0].episode_number, 2);
        assert_eq!(rows[1].show_name, "Tokyo Ghoul");
    }

    #[test]
    fn parse_rewatches_skips_short_and_bad_rows() {
        let csv = "tv_show_name,episode_season_number,episode_number,created_at\n\
                   Good Show,1,1,2020-01-01 00:00:00\n\
                   ,,,\n\
                   Truncated\n";
        let rows = parse_rewatches(csv.as_bytes());
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].show_name, "Good Show");
    }

    #[test]
    fn parse_rewatches_empty_without_header() {
        assert!(parse_rewatches(b"").is_empty());
    }
}
