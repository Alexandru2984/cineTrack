use std::collections::{HashMap, HashSet};

use chrono::{DateTime, NaiveDate, NaiveDateTime, Utc};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::dto::import::*;
use crate::services::quota;
use crate::services::tmdb::TmdbService;

/// One watch to be written to `watch_history` (episode_id None = date-only, i.e.
/// the watch counts for the heatmap/streak but no specific TMDB episode matched).
struct WatchRow {
    media_id: Uuid,
    episode_id: Option<Uuid>,
    watched_at: DateTime<Utc>,
}

struct UserMediaRow {
    media_id: Uuid,
    status: &'static str,
    is_favorite: bool,
    started_at: Option<NaiveDate>,
    completed_at: Option<NaiveDate>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

fn parse_dt(s: &Option<String>) -> Option<DateTime<Utc>> {
    let s = s.as_ref()?;
    // shows.json / movies.json use RFC3339 ("2018-12-25T00:18:11.000Z").
    if let Ok(d) = DateTime::parse_from_rfc3339(s) {
        return Some(d.with_timezone(&Utc));
    }
    // GDPR CSVs (e.g. rewatched_episode.csv) use "YYYY-MM-DD HH:MM:SS" as UTC.
    if let Ok(ndt) = NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S") {
        return Some(DateTime::from_naive_utc_and_offset(ndt, Utc));
    }
    None
}

/// Entry point run on a background task. Best-effort: a single show/movie that
/// fails to resolve is recorded in `unresolved` and skipped, never aborting the job.
pub async fn run_import(
    pool: PgPool,
    tmdb: TmdbService,
    job_id: Uuid,
    user_id: Uuid,
    shows: Vec<TvTimeShow>,
    movies: Vec<TvTimeMovie>,
    rewatches: Vec<RewatchRow>,
) {
    let _ =
        sqlx::query("UPDATE import_jobs SET status = 'running', updated_at = NOW() WHERE id = $1")
            .bind(job_id)
            .execute(&pool)
            .await;

    let result = import_all(&pool, &tmdb, job_id, user_id, shows, movies, rewatches).await;

    match result {
        Ok(totals) => {
            let _ = sqlx::query(
                "UPDATE import_jobs SET status = 'completed', totals = $2, updated_at = NOW() WHERE id = $1",
            )
            .bind(job_id)
            .bind(serde_json::to_value(&totals).unwrap_or(serde_json::Value::Null))
            .execute(&pool)
            .await;
        }
        Err(e) => {
            log::error!("Import job {job_id} failed: {e:#}");
            let _ = sqlx::query(
                "UPDATE import_jobs
                 SET status = 'failed', error = 'Import could not be completed', updated_at = NOW()
                 WHERE id = $1",
            )
            .bind(job_id)
            .execute(&pool)
            .await;
        }
    }
}

async fn import_all(
    pool: &PgPool,
    tmdb: &TmdbService,
    job_id: Uuid,
    user_id: Uuid,
    shows: Vec<TvTimeShow>,
    movies: Vec<TvTimeMovie>,
    rewatches: Vec<RewatchRow>,
) -> anyhow::Result<ImportTotals> {
    let mut totals = ImportTotals::default();
    let mut watch_rows: Vec<WatchRow> = Vec::new();
    let mut user_media_rows: Vec<UserMediaRow> = Vec::new();
    // Resolved shows keyed by normalized title, so the rewatch CSV (which only
    // carries a show name) can find the media we already cached.
    let mut title_to_media: HashMap<String, Uuid> = HashMap::new();

    for (idx, show) in shows.iter().enumerate() {
        match import_show(pool, tmdb, show).await {
            Ok(Some((media_id, um, mut rows))) => {
                totals.shows += 1;
                for r in &rows {
                    if r.episode_id.is_some() {
                        totals.episodes_linked += 1;
                    } else {
                        totals.episodes_date_only += 1;
                    }
                }
                title_to_media.insert(normalize_title(&show.title), media_id);
                user_media_rows.push(um);
                watch_rows.append(&mut rows);
            }
            Ok(None) => totals.unresolved.push(show.title.clone()),
            Err(e) => {
                log::warn!("Import job {job_id}: show index {idx} failed: {e}");
                totals.unresolved.push(show.title.clone());
            }
        }

        if (idx + 1) % 25 == 0 {
            let _ =
                sqlx::query("UPDATE import_jobs SET totals = $2, updated_at = NOW() WHERE id = $1")
                    .bind(job_id)
                    .bind(serde_json::to_value(&totals).unwrap_or(serde_json::Value::Null))
                    .execute(pool)
                    .await;
        }
    }

    for (idx, movie) in movies.iter().enumerate() {
        match import_movie(pool, tmdb, movie).await {
            Ok(Some((um, row))) => {
                totals.movies += 1;
                if let Some(r) = row {
                    watch_rows.push(r);
                }
                user_media_rows.push(um);
            }
            Ok(None) => totals.unresolved.push(movie.title.clone()),
            Err(e) => {
                log::warn!("Import job {job_id}: movie index {idx} failed: {e}");
                totals.unresolved.push(movie.title.clone());
            }
        }
    }

    // Rewatches: extra watch rows for episodes we already resolved (by show title).
    for rw in &rewatches {
        let Some(&media_id) = title_to_media.get(&normalize_title(&rw.show_name)) else {
            continue;
        };
        if let Some(episode_id) =
            resolve_episode(pool, media_id, rw.season_number, rw.episode_number).await?
        {
            if let Some(watched_at) = parse_dt(&Some(rw.created_at.clone())) {
                watch_rows.push(WatchRow {
                    media_id,
                    episode_id: Some(episode_id),
                    watched_at,
                });
                totals.rewatches += 1;
            }
        }
    }

    // Duplicate export titles can resolve to the same TMDB record. Collapse
    // those tracking rows before the bulk upsert (history events stay distinct).
    let mut unique_user_media = HashMap::with_capacity(user_media_rows.len());
    for row in user_media_rows {
        unique_user_media.insert(row.media_id, row);
    }
    let user_media_rows: Vec<UserMediaRow> = unique_user_media.into_values().collect();

    // The user's final tracking state and history become visible together.
    // TMDB cache rows may persist after a failed import, but no partial user
    // library can survive a write error.
    let mut tx = pool.begin().await?;
    let tracking_count = quota::lock_and_count_tracking(&mut tx, user_id).await?;
    let media_ids: Vec<Uuid> = user_media_rows
        .iter()
        .map(|row| row.media_id)
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let existing_tracking = if media_ids.is_empty() {
        0
    } else {
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM user_media WHERE user_id = $1 AND media_id = ANY($2)",
        )
        .bind(user_id)
        .bind(&media_ids)
        .fetch_one(&mut *tx)
        .await?
    };
    let requested_tracking = i64::try_from(media_ids.len())
        .map_err(|_| anyhow::anyhow!("tracking import is too large"))?;
    quota::ensure_tracking_capacity(tracking_count, requested_tracking - existing_tracking)?;

    let history_count = quota::lock_and_count_history(&mut tx, user_id).await?;
    let requested_history = i64::try_from(watch_rows.len())
        .map_err(|_| anyhow::anyhow!("history import is too large"))?;
    quota::ensure_history_capacity(history_count, requested_history)?;

    write_user_media(&mut tx, user_id, &user_media_rows).await?;
    write_watch_history(&mut tx, user_id, &watch_rows).await?;
    tx.commit().await?;

    Ok(totals)
}

fn normalize_title(t: &str) -> String {
    t.trim().to_lowercase()
}

/// Resolve a TV Time show to TMDB, cache it + its watched seasons' episodes, and
/// build the user_media row + watch rows. Returns None if it can't be resolved.
async fn import_show(
    pool: &PgPool,
    tmdb: &TmdbService,
    show: &TvTimeShow,
) -> anyhow::Result<Option<(Uuid, UserMediaRow, Vec<WatchRow>)>> {
    let tmdb_id = match resolve_show_id(tmdb, show).await? {
        Some(id) => id,
        None => return Ok(None),
    };

    let media = tmdb.get_or_cache_media(pool, tmdb_id, "tv").await?;

    // Watched events (season >= 1 only) + the full ordered episode list for the
    // absolute-position fallback.
    let mut watched: Vec<(i32, i32, DateTime<Utc>)> = Vec::new();
    let mut full_ordered: Vec<(i32, i32)> = Vec::new();
    for season in &show.seasons {
        if season.number < 1 {
            continue;
        }
        for ep in &season.episodes {
            full_ordered.push((season.number, ep.number));
            if ep.is_watched {
                if let Some(w) = parse_dt(&ep.watched_at) {
                    watched.push((season.number, ep.number, w));
                }
            }
        }
    }
    full_ordered.sort_unstable();

    // Cache episodes for ALL of TMDB's real seasons (not just the export's season
    // numbers). TV Time numbers some shows by year (MrBeast, Pawn Stars), which
    // don't exist on TMDB; caching the real seasons gives the absolute-position
    // fallback a complete episode list to map onto. Only worth it if watched.
    if !watched.is_empty() {
        let season_numbers = sqlx::query_scalar::<_, i32>(
            "SELECT season_number FROM seasons WHERE media_id = $1 AND season_number >= 1 ORDER BY season_number",
        )
        .bind(media.id)
        .fetch_all(pool)
        .await?;
        for sn in season_numbers {
            let _ = tmdb.cache_season_episodes(pool, &media, sn).await;
        }
    }

    // Build lookup maps from the DB episodes.
    let db_eps = sqlx::query_as::<_, (i32, i32, Uuid)>(
        r#"SELECT s.season_number, e.episode_number, e.id
           FROM episodes e JOIN seasons s ON e.season_id = s.id
           WHERE s.media_id = $1 AND s.season_number >= 1
           ORDER BY s.season_number, e.episode_number"#,
    )
    .bind(media.id)
    .fetch_all(pool)
    .await?;

    let mut direct: HashMap<(i32, i32), Uuid> = HashMap::new();
    let mut ordered: Vec<Uuid> = Vec::with_capacity(db_eps.len());
    for (sn, en, id) in &db_eps {
        direct.insert((*sn, *en), *id);
        ordered.push(*id);
    }
    // absolute position of each (season, episode) in TV Time's own ordering
    let mut tv_pos: HashMap<(i32, i32), usize> = HashMap::new();
    for (i, key) in full_ordered.iter().enumerate() {
        tv_pos.entry(*key).or_insert(i);
    }

    // Choose the strategy that links more of the watched episodes.
    let direct_hits = watched
        .iter()
        .filter(|(s, e, _)| direct.contains_key(&(*s, *e)))
        .count();
    let abs_hits = watched
        .iter()
        .filter(|(s, e, _)| {
            tv_pos
                .get(&(*s, *e))
                .map(|p| *p < ordered.len())
                .unwrap_or(false)
        })
        .count();
    let use_absolute = abs_hits > direct_hits;

    let mut rows: Vec<WatchRow> = Vec::with_capacity(watched.len());
    for (s, e, w) in &watched {
        let episode_id = if use_absolute {
            tv_pos.get(&(*s, *e)).and_then(|p| ordered.get(*p)).copied()
        } else {
            direct.get(&(*s, *e)).copied()
        };
        rows.push(WatchRow {
            media_id: media.id,
            episode_id,
            watched_at: *w,
        });
    }

    // user_media status + dates
    let total_eps = full_ordered.len();
    let watched_count = watched.len();
    let status: &'static str = if watched_count == 0 {
        "plan_to_watch"
    } else if total_eps > 0 && watched_count >= total_eps {
        "completed"
    } else {
        "watching"
    };
    let mut dates: Vec<DateTime<Utc>> = watched.iter().map(|(_, _, w)| *w).collect();
    dates.sort_unstable();
    let started_at = dates.first().map(|d| d.date_naive());
    let completed_at = if status == "completed" {
        dates.last().map(|d| d.date_naive())
    } else {
        None
    };
    let created_at = parse_dt(&show.created_at)
        .or_else(|| dates.first().copied())
        .unwrap_or_else(Utc::now);
    let updated_at = dates.last().copied().unwrap_or(created_at);

    let um = UserMediaRow {
        media_id: media.id,
        status,
        is_favorite: false,
        started_at,
        completed_at,
        created_at,
        updated_at,
    };
    Ok(Some((media.id, um, rows)))
}

async fn import_movie(
    pool: &PgPool,
    tmdb: &TmdbService,
    movie: &TvTimeMovie,
) -> anyhow::Result<Option<(UserMediaRow, Option<WatchRow>)>> {
    let tmdb_id = match resolve_movie_id(tmdb, movie).await? {
        Some(id) => id,
        None => return Ok(None),
    };
    let media = tmdb.get_or_cache_media(pool, tmdb_id, "movie").await?;

    let watched_at = parse_dt(&movie.watched_at);
    let created_at = parse_dt(&movie.created_at)
        .or(watched_at)
        .unwrap_or_else(Utc::now);

    let (status, watch, started, completed, updated): (
        &'static str,
        Option<WatchRow>,
        Option<NaiveDate>,
        Option<NaiveDate>,
        DateTime<Utc>,
    ) = if movie.is_watched {
        let w = watched_at.unwrap_or(created_at);
        (
            "completed",
            Some(WatchRow {
                media_id: media.id,
                episode_id: None,
                watched_at: w,
            }),
            Some(w.date_naive()),
            Some(w.date_naive()),
            w,
        )
    } else {
        ("plan_to_watch", None, None, None, created_at)
    };

    let um = UserMediaRow {
        media_id: media.id,
        status,
        is_favorite: false,
        started_at: started,
        completed_at: completed,
        created_at,
        updated_at: updated,
    };
    Ok(Some((um, watch)))
}

async fn resolve_show_id(tmdb: &TmdbService, show: &TvTimeShow) -> anyhow::Result<Option<i32>> {
    if let Some(tvdb) = show.id.tvdb {
        let found = tmdb
            .find_by_external_id(&tvdb.to_string(), "tvdb_id")
            .await?;
        if let Some(r) = found.tv_results.first() {
            return Ok(Some(r.id));
        }
    }
    if !show.title.is_empty() {
        let res = tmdb.search(&show.title, Some("tv"), Some(1), None).await?;
        if let Some(r) = res.results.first() {
            return Ok(Some(r.id));
        }
    }
    Ok(None)
}

async fn resolve_movie_id(tmdb: &TmdbService, movie: &TvTimeMovie) -> anyhow::Result<Option<i32>> {
    if let Some(imdb) = &movie.id.imdb {
        if imdb != "-1" && !imdb.is_empty() {
            let found = tmdb.find_by_external_id(imdb, "imdb_id").await?;
            if let Some(r) = found.movie_results.first() {
                return Ok(Some(r.id));
            }
        }
    }
    if !movie.title.is_empty() {
        let res = tmdb
            .search(&movie.title, Some("movie"), Some(1), None)
            .await?;
        if let Some(r) = res.results.first() {
            return Ok(Some(r.id));
        }
    }
    Ok(None)
}

async fn resolve_episode(
    pool: &PgPool,
    media_id: Uuid,
    season_number: i32,
    episode_number: i32,
) -> anyhow::Result<Option<Uuid>> {
    let id = sqlx::query_scalar::<_, Uuid>(
        r#"SELECT e.id FROM episodes e JOIN seasons s ON e.season_id = s.id
           WHERE s.media_id = $1 AND s.season_number = $2 AND e.episode_number = $3"#,
    )
    .bind(media_id)
    .bind(season_number)
    .bind(episode_number)
    .fetch_optional(pool)
    .await?;
    Ok(id)
}

async fn write_user_media(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    rows: &[UserMediaRow],
) -> anyhow::Result<()> {
    for chunk in rows.chunks(500) {
        let mut qb = sqlx::QueryBuilder::new(
            "INSERT INTO user_media (user_id, media_id, status, is_favorite, started_at, completed_at, created_at, updated_at) ",
        );
        qb.push_values(chunk, |mut b, r| {
            b.push_bind(user_id)
                .push_bind(r.media_id)
                .push_bind(r.status)
                .push_bind(r.is_favorite)
                .push_bind(r.started_at)
                .push_bind(r.completed_at)
                .push_bind(r.created_at)
                .push_bind(r.updated_at);
        });
        qb.push(
            " ON CONFLICT (user_id, media_id) DO UPDATE SET status = EXCLUDED.status, \
              is_favorite = EXCLUDED.is_favorite, started_at = EXCLUDED.started_at, \
              completed_at = EXCLUDED.completed_at, updated_at = EXCLUDED.updated_at",
        );
        qb.build().execute(&mut **tx).await?;
    }
    Ok(())
}

async fn write_watch_history(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    rows: &[WatchRow],
) -> anyhow::Result<()> {
    for chunk in rows.chunks(1000) {
        let mut qb = sqlx::QueryBuilder::new(
            "INSERT INTO watch_history (user_id, media_id, episode_id, watched_at) ",
        );
        qb.push_values(chunk, |mut b, r| {
            b.push_bind(user_id)
                .push_bind(r.media_id)
                .push_bind(r.episode_id)
                .push_bind(r.watched_at);
        });
        qb.build().execute(&mut **tx).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dt(s: &str) -> Option<DateTime<Utc>> {
        parse_dt(&Some(s.to_string()))
    }

    #[test]
    fn parse_dt_reads_rfc3339_timestamps() {
        // shows.json / movies.json format, including the fractional seconds.
        let parsed = dt("2018-12-25T00:18:11.000Z").expect("rfc3339 parses");
        assert_eq!(parsed.to_rfc3339(), "2018-12-25T00:18:11+00:00");
    }

    #[test]
    fn parse_dt_normalizes_a_non_utc_offset() {
        // An export written in a local offset must land on the same instant in
        // UTC, or the watch drifts into the wrong day on the heatmap.
        let parsed = dt("2018-12-25T02:18:11+02:00").expect("offset parses");
        assert_eq!(parsed, dt("2018-12-25T00:18:11Z").unwrap());
    }

    #[test]
    fn parse_dt_reads_the_gdpr_csv_format_as_utc() {
        let parsed = dt("2020-03-04 21:05:00").expect("csv format parses");
        assert_eq!(parsed.to_rfc3339(), "2020-03-04T21:05:00+00:00");
    }

    #[test]
    fn parse_dt_returns_none_for_anything_unrecognised() {
        // These arrive from a user-supplied export, so every one of them has to
        // come back None rather than panic or land on a bogus instant.
        for value in [
            "",
            "   ",
            "not a date",
            "2018-12-25",           // date only, no time
            "25-12-2018 00:18:11",  // day-first
            "2018-13-45T00:18:11Z", // out of range
            "2018-12-25T00:18:11",  // no zone, not the CSV shape either
            "2018-12-25 00:18",     // missing seconds
        ] {
            assert!(dt(value).is_none(), "expected {value:?} to be rejected");
        }
        assert!(parse_dt(&None).is_none());
    }

    #[test]
    fn normalize_title_trims_and_lowercases() {
        assert_eq!(normalize_title("  The Expanse  "), "the expanse");
        assert_eq!(normalize_title("BREAKING BAD"), "breaking bad");
        assert_eq!(normalize_title("already normal"), "already normal");
    }

    #[test]
    fn normalize_title_handles_non_ascii_titles() {
        // Titles come straight from the export, so diacritics must fold the same
        // way on both sides of a comparison.
        assert_eq!(normalize_title(" Văzute "), "văzute");
        assert_eq!(normalize_title("ÉTÉ"), "été");
    }

    #[test]
    fn normalize_title_collapses_only_the_edges() {
        // Interior spacing is significant; only surrounding whitespace goes.
        assert_eq!(normalize_title("\tThe  Wire\n"), "the  wire");
    }
}
