use actix_multipart::Multipart;
use actix_web::{web, HttpRequest, HttpResponse};
use futures_util::{FutureExt, StreamExt};
use sqlx::PgPool;
use std::panic::AssertUnwindSafe;
use std::sync::{Arc, LazyLock};
use tokio::sync::Semaphore;
use uuid::Uuid;

use crate::dto::import::*;
use crate::errors::AppError;
use crate::middleware::auth::require_auth;
use crate::services::importer;
use crate::services::quota;
use crate::services::tmdb::TmdbService;

/// Max size accepted for any single uploaded export file.
const MAX_FILE_BYTES: usize = 16 * 1024 * 1024;
const MAX_UPLOAD_BYTES: usize = 24 * 1024 * 1024;
const MAX_TITLES: usize = 5_000;
const MAX_EPISODE_RECORDS: usize = 100_000;
const MAX_REWATCH_ROWS: usize = 100_000;
const MAX_HISTORY_EVENTS_PER_IMPORT: usize = quota::MAX_HISTORY_EVENTS_PER_USER as usize;
const MAX_TITLE_BYTES: usize = 200;
const MAX_DATE_BYTES: usize = 64;
const MAX_CONCURRENT_IMPORTS: usize = 2;

static IMPORT_SLOTS: LazyLock<Arc<Semaphore>> =
    LazyLock::new(|| Arc::new(Semaphore::new(MAX_CONCURRENT_IMPORTS)));

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::scope("/import")
            .route("/tvtime", web::post().to(start_import))
            .route("/jobs", web::get().to(list_jobs))
            .route("/jobs/{id}", web::get().to(get_job)),
    );
}

async fn read_field(
    field: &mut actix_multipart::Field,
    total_bytes: &mut usize,
) -> Result<Vec<u8>, AppError> {
    let mut buf = Vec::new();
    while let Some(chunk) = field.next().await {
        let data = chunk.map_err(|_| AppError::BadRequest("Upload read error".to_string()))?;
        if data.len() > MAX_FILE_BYTES.saturating_sub(buf.len())
            || data.len() > MAX_UPLOAD_BYTES.saturating_sub(*total_bytes)
        {
            return Err(AppError::BadRequest(
                "Uploaded file is too large".to_string(),
            ));
        }
        buf.extend_from_slice(&data);
        *total_bytes += data.len();
    }
    Ok(buf)
}

/// Parse the TV Time GDPR `rewatched_episode.csv`.
///
/// Through a real CSV reader, not `split(',')`. A comma inside a quoted field
/// is data, and titles have commas in them: `"Love, Death & Robots"` shifted
/// every field after the title, the season number then failed to parse, and the
/// row was dropped. Silently — the job reported success while some rewatches
/// simply were not there, which shows up later as wrong statistics and streaks
/// rather than as an import error.
///
/// Rejections are counted and the first few explained, because "some rows did
/// not import" is only useful if it says which and why.
fn parse_rewatches(bytes: &[u8]) -> Result<(Vec<RewatchRow>, RewatchRejections), AppError> {
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(true)
        .flexible(true)
        .from_reader(bytes);

    let headers = match reader.headers() {
        Ok(headers) => headers.clone(),
        // An unreadable header means nothing below it can be placed.
        Err(_) => return Ok((Vec::new(), RewatchRejections::default())),
    };
    let idx = |name: &str| headers.iter().position(|c| c.trim() == name);
    let (Some(i_name), Some(i_season), Some(i_ep), Some(i_created)) = (
        idx("tv_show_name"),
        idx("episode_season_number"),
        idx("episode_number"),
        idx("created_at"),
    ) else {
        return Ok((Vec::new(), RewatchRejections::default()));
    };
    let max_idx = i_name.max(i_season).max(i_ep).max(i_created);

    let mut out = Vec::new();
    let mut rejections = RewatchRejections::default();
    for (number, record) in reader.records().enumerate() {
        let line = number + 2; // one-based, past the header
        let Ok(record) = record else {
            rejections.note(line, "the row could not be read as CSV");
            continue;
        };
        if record.len() <= max_idx {
            rejections.note(line, "the row has fewer columns than the header");
            continue;
        }
        let (Ok(season), Ok(episode)) = (
            record[i_season].trim().parse::<i32>(),
            record[i_ep].trim().parse::<i32>(),
        ) else {
            rejections.note(line, "the season or episode number is not a number");
            continue;
        };
        if out.len() == MAX_REWATCH_ROWS {
            return Err(AppError::BadRequest(
                "Rewatch export contains too many rows".to_string(),
            ));
        }
        out.push(RewatchRow {
            show_name: record[i_name].trim().to_string(),
            season_number: season,
            episode_number: episode,
            created_at: record[i_created].trim().to_string(),
        });
    }
    Ok((out, rejections))
}

/// What the parser could not place, and why.
///
/// Bounded on purpose: a malformed export should not turn into a megabyte of
/// explanation. The count is complete; the reasons are a sample.
#[derive(Debug, Default)]
pub struct RewatchRejections {
    pub count: usize,
    pub reasons: Vec<String>,
}

impl RewatchRejections {
    const MAX_REASONS: usize = 5;

    fn note(&mut self, line: usize, reason: &str) {
        self.count += 1;
        if self.reasons.len() < Self::MAX_REASONS {
            self.reasons.push(format!("line {line}: {reason}"));
        }
    }
}

fn validate_import_payload(
    shows: &[TvTimeShow],
    movies: &[TvTimeMovie],
    rewatches: &[RewatchRow],
) -> Result<usize, AppError> {
    if shows.len().saturating_add(movies.len()) > MAX_TITLES {
        return Err(AppError::BadRequest(
            "Import contains too many titles".to_string(),
        ));
    }

    let mut episode_records = 0_usize;
    let mut history_events = rewatches.len();
    for show in shows {
        validate_external_id(&show.id)?;
        validate_text(&show.title, MAX_TITLE_BYTES, "Show title is too long")?;
        validate_optional_text(&show.created_at, MAX_DATE_BYTES, "Show date is too long")?;
        for season in &show.seasons {
            if !(0..=10_000).contains(&season.number) {
                return Err(AppError::BadRequest(
                    "Invalid season number in import".to_string(),
                ));
            }
            episode_records = episode_records
                .checked_add(season.episodes.len())
                .ok_or_else(|| AppError::BadRequest("Import is too large".to_string()))?;
            if episode_records > MAX_EPISODE_RECORDS {
                return Err(AppError::BadRequest(
                    "Import contains too many episode records".to_string(),
                ));
            }
            for episode in &season.episodes {
                if !(1..=100_000).contains(&episode.number) {
                    return Err(AppError::BadRequest(
                        "Invalid episode number in import".to_string(),
                    ));
                }
                validate_optional_text(
                    &episode.watched_at,
                    MAX_DATE_BYTES,
                    "Episode date is too long",
                )?;
                if episode.is_watched {
                    history_events = history_events
                        .checked_add(1)
                        .ok_or_else(|| AppError::BadRequest("Import is too large".to_string()))?;
                }
            }
        }
    }

    for movie in movies {
        validate_external_id(&movie.id)?;
        validate_text(&movie.title, MAX_TITLE_BYTES, "Movie title is too long")?;
        validate_optional_text(&movie.watched_at, MAX_DATE_BYTES, "Movie date is too long")?;
        validate_optional_text(&movie.created_at, MAX_DATE_BYTES, "Movie date is too long")?;
        if movie.is_watched {
            history_events = history_events
                .checked_add(1)
                .ok_or_else(|| AppError::BadRequest("Import is too large".to_string()))?;
        }
    }

    for rewatch in rewatches {
        validate_text(
            &rewatch.show_name,
            MAX_TITLE_BYTES,
            "Rewatch show title is too long",
        )?;
        validate_text(
            &rewatch.created_at,
            MAX_DATE_BYTES,
            "Rewatch date is too long",
        )?;
        if !(0..=10_000).contains(&rewatch.season_number)
            || !(1..=100_000).contains(&rewatch.episode_number)
        {
            return Err(AppError::BadRequest(
                "Invalid episode number in rewatch export".to_string(),
            ));
        }
    }

    validate_import_history_count(history_events)?;
    Ok(history_events)
}

fn validate_import_history_count(history_events: usize) -> Result<(), AppError> {
    if history_events > MAX_HISTORY_EVENTS_PER_IMPORT {
        return Err(AppError::BadRequest(format!(
            "Import can contain at most {MAX_HISTORY_EVENTS_PER_IMPORT} watch events"
        )));
    }
    Ok(())
}

fn validate_external_id(id: &TvTimeExternalId) -> Result<(), AppError> {
    let invalid_tvdb = id.tvdb.is_some_and(|value| value <= 0);
    let invalid_imdb = id.imdb.as_ref().is_some_and(|value| {
        !value.is_empty()
            && value != "-1"
            && !crate::services::tmdb::is_valid_external_lookup_id(value, "imdb_id")
    });
    if invalid_tvdb || invalid_imdb {
        return Err(AppError::BadRequest(
            "Invalid external ID in import".to_string(),
        ));
    }
    Ok(())
}

fn validate_text(value: &str, max_bytes: usize, message: &str) -> Result<(), AppError> {
    if value.len() > max_bytes {
        return Err(AppError::BadRequest(message.to_string()));
    }
    Ok(())
}

fn validate_optional_text(
    value: &Option<String>,
    max_bytes: usize,
    message: &str,
) -> Result<(), AppError> {
    if let Some(value) = value {
        validate_text(value, max_bytes, message)?;
    }
    Ok(())
}

async fn start_import(
    pool: web::Data<PgPool>,
    tmdb: web::Data<TmdbService>,
    req: HttpRequest,
    mut payload: Multipart,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;

    let mut shows_bytes: Option<Vec<u8>> = None;
    let mut movies_bytes: Option<Vec<u8>> = None;
    let mut rewatch_bytes: Option<Vec<u8>> = None;
    let mut total_bytes = 0_usize;

    while let Some(item) = payload.next().await {
        let mut field = item.map_err(|_| AppError::BadRequest("Malformed upload".to_string()))?;
        let name = field
            .content_disposition()
            .and_then(|cd| cd.get_name())
            .unwrap_or("")
            .to_string();
        match name.as_str() {
            "shows" if shows_bytes.is_none() => {
                shows_bytes = Some(read_field(&mut field, &mut total_bytes).await?)
            }
            "movies" if movies_bytes.is_none() => {
                movies_bytes = Some(read_field(&mut field, &mut total_bytes).await?)
            }
            "rewatches" if rewatch_bytes.is_none() => {
                rewatch_bytes = Some(read_field(&mut field, &mut total_bytes).await?)
            }
            "shows" | "movies" | "rewatches" => {
                return Err(AppError::BadRequest(
                    "Duplicate import file field".to_string(),
                ));
            }
            _ => {
                return Err(AppError::BadRequest(
                    "Unexpected import file field".to_string(),
                ));
            }
        }
    }

    let shows: Vec<TvTimeShow> = match &shows_bytes {
        Some(b) if !b.is_empty() => parse_limited_json_array(b, MAX_TITLES)
            .map_err(|_| AppError::BadRequest("Invalid shows.json".to_string()))?,
        _ => Vec::new(),
    };
    let movies: Vec<TvTimeMovie> = match &movies_bytes {
        Some(b) if !b.is_empty() => parse_limited_json_array(b, MAX_TITLES)
            .map_err(|_| AppError::BadRequest("Invalid movies.json".to_string()))?,
        _ => Vec::new(),
    };
    let (rewatches, rewatch_rejections) = rewatch_bytes
        .as_deref()
        .map(parse_rewatches)
        .transpose()?
        .unwrap_or_default();
    if rewatch_rejections.count > 0 {
        // Not an error: an export can carry rows this importer has no use for.
        // But it stops being silent, because "the import worked" while some
        // rewatches were dropped shows up later as wrong statistics, with
        // nothing to trace it to.
        log::info!(
            "import: {} rewatch row(s) rejected; {}",
            rewatch_rejections.count,
            rewatch_rejections.reasons.join("; ")
        );
    }

    if shows.is_empty() && movies.is_empty() {
        return Err(AppError::BadRequest(
            "Upload at least shows.json or movies.json".to_string(),
        ));
    }
    let incoming_history_events = validate_import_payload(&shows, &movies, &rewatches)?;

    // Conservative preflight checks avoid doing thousands of TMDB lookups for
    // an import that cannot fit. Exact de-duplicated counts are checked again
    // in the import transaction.
    let (tracking_count, history_count) = sqlx::query_as::<_, (i64, i64)>(
        "SELECT
            (SELECT COUNT(*) FROM user_media WHERE user_id = $1),
            (SELECT COUNT(*) FROM watch_history WHERE user_id = $1)",
    )
    .bind(user_id)
    .fetch_one(pool.get_ref())
    .await?;
    let incoming_titles = i64::try_from(shows.len().saturating_add(movies.len()))
        .map_err(|_| AppError::BadRequest("Import is too large".to_string()))?;
    let incoming_history_events = i64::try_from(incoming_history_events)
        .map_err(|_| AppError::BadRequest("Import is too large".to_string()))?;
    quota::ensure_tracking_capacity(tracking_count, incoming_titles)?;
    quota::ensure_history_capacity(history_count, incoming_history_events)?;

    let permit = Arc::clone(&IMPORT_SLOTS).try_acquire_owned().map_err(|_| {
        AppError::TooManyRequests("The import service is busy; try again later".to_string())
    })?;

    // One non-failed import per user keeps history idempotent. The partial
    // unique index makes this reservation atomic across concurrent requests.
    let job_id = sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO import_jobs (user_id, status) VALUES ($1, 'pending')
         ON CONFLICT DO NOTHING RETURNING id",
    )
    .bind(user_id)
    .fetch_optional(pool.get_ref())
    .await?
    .ok_or_else(|| AppError::Conflict("An import already exists for this account".to_string()))?;

    let pool_c = pool.get_ref().clone();
    let tmdb_c = tmdb.get_ref().clone();
    actix_web::rt::spawn(async move {
        let _permit = permit;
        let outcome = AssertUnwindSafe(importer::run_import(
            pool_c.clone(),
            tmdb_c,
            job_id,
            user_id,
            shows,
            movies,
            rewatches,
        ))
        .catch_unwind()
        .await;
        if outcome.is_err() {
            log::error!("Import job {job_id} panicked");
            let _ = sqlx::query(
                "UPDATE import_jobs
                 SET status = 'failed', error = 'Import could not be completed', updated_at = NOW()
                 WHERE id = $1",
            )
            .bind(job_id)
            .execute(&pool_c)
            .await;
        }
    });

    crate::metrics::record_product_action(crate::metrics::ProductAction::TvTimeImportStarted);
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

async fn list_jobs(pool: web::Data<PgPool>, req: HttpRequest) -> Result<HttpResponse, AppError> {
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
        let (rows, rejected) = parse_rewatches(csv.as_bytes()).unwrap();
        assert_eq!(rejected.count, 0);
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
        let (rows, rejected) = parse_rewatches(csv.as_bytes()).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].show_name, "Good Show");
        // Rejected rather than ignored, and countable.
        assert_eq!(rejected.count, 2);
        assert!(rejected
            .reasons
            .iter()
            .any(|reason| reason.starts_with("line 3")));
    }

    /// A comma inside a quoted title is data, not a separator.
    ///
    /// This is the whole of M15. `split(',')` shifted every field after the
    /// title, the season number then failed to parse, and the row vanished
    /// without a word — while the job reported success.
    #[test]
    fn parse_rewatches_keeps_titles_containing_commas() {
        let csv = "tv_show_name,episode_season_number,episode_number,created_at\n\
                   \"Love, Death & Robots\",3,4,2024-05-01 10:00:00\n\
                   \"He said \"\"hi\"\", then left\",1,2,2024-05-02 10:00:00\n\
                   Plain Title,2,3,2024-05-03 10:00:00\n";
        let (rows, rejected) = parse_rewatches(csv.as_bytes()).unwrap();
        assert_eq!(rejected.count, 0, "{:?}", rejected.reasons);
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].show_name, "Love, Death & Robots");
        assert_eq!(rows[0].season_number, 3);
        assert_eq!(rows[0].episode_number, 4);
        assert_eq!(rows[1].show_name, "He said \"hi\", then left");
        assert_eq!(rows[2].show_name, "Plain Title");
    }

    /// A quoted field may contain the line separator too.
    #[test]
    fn parse_rewatches_keeps_titles_containing_newlines() {
        let csv = "tv_show_name,episode_season_number,episode_number,created_at\n\
                   \"Two\nLines\",1,1,2024-05-01 10:00:00\n";
        let (rows, rejected) = parse_rewatches(csv.as_bytes()).unwrap();
        assert_eq!(rejected.count, 0);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].show_name, "Two\nLines");
    }

    #[test]
    fn parse_rewatches_empty_without_header() {
        assert!(parse_rewatches(b"").unwrap().0.is_empty());
    }

    #[test]
    fn limited_json_parser_rejects_too_many_top_level_items() {
        let json = br#"[
            {"id": {}, "title": "One"},
            {"id": {}, "title": "Two"},
            {"id": {}, "title": "Three"}
        ]"#;

        assert!(parse_limited_json_array::<TvTimeMovie>(json, 2).is_err());
    }

    #[test]
    fn payload_validation_rejects_oversized_untrusted_fields() {
        let shows = vec![TvTimeShow {
            id: TvTimeExternalId {
                tvdb: Some(1),
                imdb: None,
            },
            title: "x".repeat(MAX_TITLE_BYTES + 1),
            seasons: Vec::new(),
            created_at: None,
        }];

        assert!(validate_import_payload(&shows, &[], &[]).is_err());
    }

    #[test]
    fn payload_validation_accepts_a_bounded_export() {
        let shows = vec![TvTimeShow {
            id: TvTimeExternalId {
                tvdb: Some(1),
                imdb: None,
            },
            title: "Example".to_string(),
            seasons: vec![TvTimeSeason {
                number: 1,
                episodes: vec![TvTimeEpisode {
                    number: 1,
                    is_watched: true,
                    watched_at: Some("2026-01-01T00:00:00Z".to_string()),
                }],
            }],
            created_at: None,
        }];

        assert!(validate_import_payload(&shows, &[], &[]).is_ok());
    }

    #[test]
    fn import_watch_event_limit_has_an_exact_boundary() {
        assert!(validate_import_history_count(MAX_HISTORY_EVENTS_PER_IMPORT).is_ok());
        assert!(validate_import_history_count(MAX_HISTORY_EVENTS_PER_IMPORT + 1).is_err());
    }

    #[test]
    fn payload_validation_rejects_path_like_imdb_ids() {
        let movies = vec![TvTimeMovie {
            id: TvTimeExternalId {
                tvdb: None,
                imdb: Some("../../account".to_string()),
            },
            title: "Example".to_string(),
            is_watched: false,
            watched_at: None,
            created_at: None,
        }];

        assert!(validate_import_payload(&[], &movies, &[]).is_err());
    }

    #[test]
    fn payload_validation_rejects_non_positive_tvdb_ids() {
        let shows = vec![TvTimeShow {
            id: TvTimeExternalId {
                tvdb: Some(-1),
                imdb: None,
            },
            title: "Example".to_string(),
            seasons: Vec::new(),
            created_at: None,
        }];

        assert!(validate_import_payload(&shows, &[], &[]).is_err());
    }
}
