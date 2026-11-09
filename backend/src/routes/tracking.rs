use actix_web::{web, HttpRequest, HttpResponse};
use chrono::{NaiveDate, Utc};
use sqlx::{PgPool, Postgres, Transaction};
use std::collections::HashSet;
use std::sync::LazyLock;
use uuid::Uuid;
use validator::Validate;

use crate::dto::tracking::*;
use crate::errors::AppError;
use crate::middleware::auth::require_auth;
use crate::routes::hubs::genre_by_id;
use crate::routes::title_pages::Language;
use crate::services::quota;
use crate::services::tmdb::TmdbService;

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::scope("/tracking")
            .route("", web::get().to(list_tracking))
            .route("/facets", web::get().to(tracking_facets))
            .route("", web::post().to(create_tracking))
            .route("/lookup", web::post().to(lookup_tracking))
            .route("/{id}", web::patch().to(update_tracking))
            .route("/{id}", web::delete().to(delete_tracking)),
    );
}

type TrackingRow = (
    Uuid,
    Uuid,
    i32,
    String,
    String,
    Option<String>,
    String,
    Option<i16>,
    Option<String>,
    bool,
    Option<NaiveDate>,
    Option<NaiveDate>,
    Option<NaiveDate>,
);

fn tracking_response(
    (
        id,
        media_id,
        tmdb_id,
        media_type,
        title,
        poster_path,
        status,
        rating,
        review,
        is_favorite,
        started_at,
        completed_at,
        release_date,
    ): TrackingRow,
) -> TrackingResponse {
    TrackingResponse {
        id,
        media_id,
        tmdb_id,
        media_type,
        title,
        poster_path,
        status,
        rating,
        review,
        is_favorite,
        started_at,
        completed_at,
        release_date,
    }
}

/// Accents people leave out when they type, and what they type instead, one
/// character for one: "sarbatori" finds "Sărbători", "pokemon" finds
/// "Pokémon". Both sides of the comparison are lowered first, so only
/// lowercase letters are needed here.
const FOLD_FROM: &str = "ăâîșşțţáàäãåéèêëíìïóòôöõőúùûüűñçčćšžýÿōū";
const FOLD_TO: &str = "aaissttaaaaaeeeeiiioooooouuuuuncccszyyou";

/// The search as the SQL compares it: folded here once, not per name.
fn fold(text: &str) -> String {
    text.to_lowercase()
        .chars()
        .map(|letter| {
            FOLD_FROM
                .chars()
                .position(|accented| accented == letter)
                .and_then(|index| FOLD_TO.chars().nth(index))
                .unwrap_or(letter)
        })
        .collect()
}

/// A name, folded the way `fold` folds the search. translate() is most of
/// the search's cost, and most titles are plain ASCII, which only needs
/// lowering: one byte per character says so without looking further.
fn folded_name(expression: &str) -> String {
    format!(
        "CASE WHEN octet_length({expression}) = char_length({expression}) \
         THEN lower({expression}) \
         ELSE translate(lower({expression}), '{FOLD_FROM}', '{FOLD_TO}') END"
    )
}

/// One user's library with every filter evaluated but none applied yet:
/// the list keeps the rows that pass them all, and each facet counts with all
/// but its own. That is what makes a facet's number the length of the list
/// its choice would give.
///
/// The title search is applied here rather than counted around, so the
/// facets describe what the search found. The list shows TMDB's English
/// title and the person may remember another, so it also reads the original
/// title, the Romanian and English translations, and the alternative titles
/// used in Romania, the US, the UK and Japan (romanised anime names are filed
/// under Japan). Every alias would be ~35,000 names for a 900-title library
/// and 900 ms a search, nearly all of them in scripts nobody types here; these
/// are about a third of that, and 90 ms.
///
/// Anime is Animation (TMDB genre 16) made in Japanese. TMDB has no genre for
/// it, and the country is not stored for films; see the
/// `media_original_language` migration.
///
/// Binds: $1 user, $2 status, $3 media type, $4 genre id, $5 anime only,
/// $6 favourite, $7 title search, already folded.
fn library_cte() -> String {
    let name = folded_name("names.title");
    format!(
        r#"WITH library AS (
            SELECT
                um.id, um.media_id, m.tmdb_id, m.media_type, m.title, m.poster_path,
                um.status, um.rating, um.review, um.is_favorite, um.started_at,
                um.completed_at, m.release_date, um.updated_at, um.created_at, m.genres,
                COALESCE(
                    m.genres @> '[{{"id": 16}}]' AND m.original_language = 'ja',
                    FALSE
                ) AS is_anime
            FROM user_media um
            JOIN media m ON m.id = um.media_id
            WHERE um.user_id = $1
              AND ($7::text IS NULL OR EXISTS (
                  SELECT 1
                  FROM (
                      SELECT m.title
                      UNION ALL SELECT m.original_title
                      UNION ALL
                      SELECT aliases.title
                      FROM media_title_aliases aliases
                      WHERE aliases.media_id = m.id
                        AND (
                            (aliases.kind = 'translation' AND aliases.language_code IN ('ro', 'en'))
                            OR (aliases.kind = 'alternative' AND aliases.region_code IN ('RO', 'US', 'GB', 'JP'))
                        )
                  ) names (title)
                  WHERE strpos({name}, $7) > 0
              ))
        ), matched AS (
            SELECT
                library.*,
                ($2::text IS NULL OR status = $2) AS status_matches,
                ($3::text IS NULL OR media_type = $3) AS type_matches,
                CASE
                    WHEN $5::bool THEN is_anime
                    WHEN $4::int IS NULL THEN TRUE
                    ELSE COALESCE(
                        genres @> jsonb_build_array(jsonb_build_object('id', $4::int)),
                        FALSE
                    )
                END AS genre_matches,
                ($6::bool IS NULL OR is_favorite = $6) AS favorite_matches
            FROM library
        )"#
    )
}

/// The filters as the queries bind them.
struct LibraryFilter {
    status: Option<String>,
    media_type: Option<String>,
    genre_id: Option<i32>,
    anime: bool,
    favorite: Option<bool>,
    title: Option<String>,
}

impl LibraryFilter {
    fn new(params: &TrackingQueryParams) -> Self {
        let genre = params.genre.as_deref();
        Self {
            status: params.status.clone(),
            media_type: params.media_type.clone(),
            genre_id: genre.and_then(|genre| genre.parse().ok()),
            anime: genre == Some("anime"),
            favorite: params.favorite,
            title: params
                .q
                .as_deref()
                .map(str::trim)
                .filter(|q| !q.is_empty())
                .map(fold),
        }
    }

    fn bind<'q, O>(
        &'q self,
        query: sqlx::query::QueryAs<'q, Postgres, O, sqlx::postgres::PgArguments>,
        user_id: Uuid,
    ) -> sqlx::query::QueryAs<'q, Postgres, O, sqlx::postgres::PgArguments> {
        query
            .bind(user_id)
            .bind(self.status.as_deref())
            .bind(self.media_type.as_deref())
            .bind(self.genre_id)
            .bind(self.anime)
            .bind(self.favorite)
            .bind(self.title.as_deref())
    }
}

/// Every order ends on the entry id, so a page boundary never falls between
/// two rows that compare equal and shows one of them twice.
fn library_order(sort: Option<&str>) -> &'static str {
    match sort {
        Some("added") => "created_at DESC, id DESC",
        Some("title") => "lower(title), id",
        Some("rating") => "rating DESC NULLS LAST, updated_at DESC, id DESC",
        Some("release") => "release_date DESC NULLS LAST, id DESC",
        _ => "updated_at DESC, id DESC",
    }
}

/// The list in each order `VALID_TRACKING_SORTS` names, in that order. Built
/// once from constant pieces: nothing a request sends ends up in the text.
static LIST_SQL: LazyLock<Vec<String>> = LazyLock::new(|| {
    VALID_TRACKING_SORTS
        .iter()
        .map(|sort| {
            format!(
                r#"{}
        SELECT id, media_id, tmdb_id, media_type, title, poster_path, status, rating,
               review, is_favorite, started_at, completed_at, release_date
        FROM matched
        WHERE status_matches AND type_matches AND genre_matches AND favorite_matches
        ORDER BY {}
        LIMIT $8 OFFSET $9"#,
                library_cte(),
                library_order(Some(sort)),
            )
        })
        .collect()
});

/// Each facet counts the rows that pass every filter but its own.
static FACETS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        r#"{}
        SELECT 'status', status, NULL, COUNT(*)
        FROM matched WHERE type_matches AND genre_matches AND favorite_matches
        GROUP BY status
        UNION ALL
        SELECT 'media_type', media_type, NULL, COUNT(*)
        FROM matched WHERE status_matches AND genre_matches AND favorite_matches
        GROUP BY media_type
        UNION ALL
        SELECT 'genre', genre->>'id', MAX(genre->>'name'), COUNT(*)
        FROM matched
        CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(genres) = 'array' THEN genres ELSE '[]'::jsonb END
        ) genre
        WHERE status_matches AND type_matches AND favorite_matches
        GROUP BY genre->>'id'
        UNION ALL
        SELECT 'anime', NULL, NULL, COUNT(*) FILTER (WHERE is_anime)
        FROM matched WHERE status_matches AND type_matches AND favorite_matches
        UNION ALL
        SELECT 'favorite', NULL, NULL, COUNT(*) FILTER (WHERE is_favorite)
        FROM matched WHERE status_matches AND type_matches AND genre_matches
        UNION ALL
        SELECT 'total', NULL, NULL, COUNT(*)
        FROM matched
        WHERE status_matches AND type_matches AND genre_matches AND favorite_matches"#,
        library_cte(),
    )
});

async fn list_tracking(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    query: web::Query<TrackingQueryParams>,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    query.validate()?;
    let params = query.into_inner();
    let limit = params.limit.unwrap_or(50).min(100) as i64;
    let offset = ((params.page.unwrap_or(1).max(1) - 1) as i64) * limit;
    let filter = LibraryFilter::new(&params);

    // Validation has already refused any other sort; the default is first.
    let order = VALID_TRACKING_SORTS
        .iter()
        .position(|sort| Some(*sort) == params.sort.as_deref())
        .unwrap_or(0);
    let sql = LIST_SQL[order].as_str();
    let rows = filter
        .bind(sqlx::query_as::<_, TrackingRow>(sql), user_id)
        .bind(limit)
        .bind(offset)
        .fetch_all(pool.get_ref())
        .await?;

    let response: Vec<TrackingResponse> = rows.into_iter().map(tracking_response).collect();

    Ok(HttpResponse::Ok().json(response))
}

async fn tracking_facets(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    query: web::Query<TrackingQueryParams>,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    query.validate()?;
    let params = query.into_inner();
    let filter = LibraryFilter::new(&params);
    let language = match params.language.as_deref() {
        Some(language) if language.to_ascii_lowercase().starts_with("ro") => Language::Ro,
        _ => Language::En,
    };

    let rows = filter
        .bind(
            sqlx::query_as::<_, (String, Option<String>, Option<String>, i64)>(FACETS_SQL.as_str()),
            user_id,
        )
        .fetch_all(pool.get_ref())
        .await?;

    Ok(HttpResponse::Ok().json(facets_from_rows(rows, language)))
}

fn facets_from_rows(
    rows: Vec<(String, Option<String>, Option<String>, i64)>,
    language: Language,
) -> TrackingFacets {
    let mut facets = TrackingFacets {
        total: 0,
        statuses: Default::default(),
        media_types: Default::default(),
        genres: Vec::new(),
        anime: 0,
        favorites: 0,
    };
    for (facet, key, stored_name, count) in rows {
        match (facet.as_str(), key) {
            ("status", Some(status)) => {
                facets.statuses.insert(status, count);
            }
            ("media_type", Some(media_type)) => {
                facets.media_types.insert(media_type, count);
            }
            ("genre", Some(id)) => {
                let Ok(id) = id.parse::<i32>() else { continue };
                // TMDB's name is English whatever the reader's language, and
                // the hub table has both. A genre TMDB adds later keeps its
                // own name until the table learns it.
                let name = genre_by_id(id)
                    .map(|genre| genre.name(language).to_string())
                    .or(stored_name)
                    .filter(|name| !name.trim().is_empty());
                if let Some(name) = name {
                    facets.genres.push(GenreFacet { id, name, count });
                }
            }
            ("anime", _) => facets.anime = count,
            ("favorite", _) => facets.favorites = count,
            ("total", _) => facets.total = count,
            _ => {}
        }
    }
    facets.genres.sort_by(|left, right| {
        right
            .count
            .cmp(&left.count)
            .then_with(|| left.name.cmp(&right.name))
    });
    facets
}

async fn lookup_tracking(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    body: web::Json<TrackingLookupRequest>,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    body.validate()?;
    for item in &body.items {
        item.validate()?;
    }

    let mut seen = HashSet::with_capacity(body.items.len());
    let mut tmdb_ids = Vec::with_capacity(body.items.len());
    let mut media_types = Vec::with_capacity(body.items.len());
    for item in &body.items {
        if seen.insert((item.tmdb_id, item.media_type.as_str())) {
            tmdb_ids.push(item.tmdb_id);
            media_types.push(item.media_type.clone());
        }
    }

    let rows = sqlx::query_as::<_, TrackingRow>(
        r#"WITH requested AS (
            SELECT *
            FROM UNNEST($2::integer[], $3::text[]) AS item(tmdb_id, media_type)
        )
        SELECT um.id, um.media_id, m.tmdb_id, m.media_type, m.title, m.poster_path,
               um.status, um.rating, um.review, um.is_favorite, um.started_at, um.completed_at,
               m.release_date
        FROM requested item
        JOIN media m ON m.tmdb_id = item.tmdb_id AND m.media_type = item.media_type
        JOIN user_media um ON um.media_id = m.id AND um.user_id = $1"#,
    )
    .bind(user_id)
    .bind(&tmdb_ids)
    .bind(&media_types)
    .fetch_all(pool.get_ref())
    .await?;

    let response: Vec<TrackingResponse> = rows.into_iter().map(tracking_response).collect();
    Ok(HttpResponse::Ok().json(response))
}

async fn create_tracking(
    pool: web::Data<PgPool>,
    tmdb: web::Data<TmdbService>,
    req: HttpRequest,
    body: web::Json<CreateTrackingRequest>,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    body.validate()?;
    let data = body.into_inner();

    // Reject obviously full libraries before an upstream lookup can populate
    // the shared TMDB cache. The transaction below repeats this atomically.
    let (tracking_count, already_tracked) = sqlx::query_as::<_, (i64, bool)>(
        r#"SELECT
            (SELECT COUNT(*) FROM user_media WHERE user_id = $1),
            EXISTS(
                SELECT 1
                FROM user_media um
                JOIN media m ON m.id = um.media_id
                WHERE um.user_id = $1 AND m.tmdb_id = $2 AND m.media_type = $3
            )"#,
    )
    .bind(user_id)
    .bind(data.tmdb_id)
    .bind(&data.media_type)
    .fetch_one(pool.get_ref())
    .await?;
    quota::ensure_tracking_capacity(tracking_count, if already_tracked { 0 } else { 1 })?;

    let media = tmdb
        .get_or_cache_media(pool.get_ref(), data.tmdb_id, &data.media_type)
        .await?;

    let mut tx = pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1::text || ':' || $2::text, 0))")
        .bind(user_id)
        .bind(media.id)
        .execute(&mut *tx)
        .await?;

    let tracking_count = quota::lock_and_count_tracking(&mut tx, user_id).await?;
    let previous_status = sqlx::query_scalar::<_, String>(
        "SELECT status FROM user_media WHERE user_id = $1 AND media_id = $2",
    )
    .bind(user_id)
    .bind(media.id)
    .fetch_optional(&mut *tx)
    .await?;
    quota::ensure_tracking_capacity(
        tracking_count,
        if previous_status.is_some() { 0 } else { 1 },
    )?;

    let user_media = sqlx::query_as::<_, crate::models::UserMedia>(
        r#"INSERT INTO user_media (user_id, media_id, status, started_at, completed_at)
        VALUES ($1, $2, $3,
            CASE WHEN $3 IN ('watching', 'completed') THEN CURRENT_DATE END,
            CASE WHEN $3 = 'completed' THEN CURRENT_DATE END
        )
        ON CONFLICT (user_id, media_id) DO UPDATE SET status = $3, updated_at = NOW(),
            started_at = COALESCE(user_media.started_at, CASE WHEN $3 IN ('watching', 'completed') THEN CURRENT_DATE END),
            completed_at = CASE
                WHEN $3 = 'completed' THEN COALESCE(user_media.completed_at, CURRENT_DATE)
                ELSE NULL
            END
        RETURNING *"#
    )
    .bind(user_id)
    .bind(media.id)
    .bind(&data.status)
    .fetch_one(&mut *tx)
    .await?;

    if data.status == "completed" && previous_status.as_deref() != Some("completed") {
        record_completion_history(&mut tx, user_id, media.id, &media.media_type).await?;
    }
    tx.commit().await?;

    Ok(HttpResponse::Created().json(TrackingResponse {
        id: user_media.id,
        media_id: media.id,
        tmdb_id: media.tmdb_id,
        media_type: media.media_type,
        title: media.title,
        poster_path: media.poster_path,
        status: user_media.status,
        rating: user_media.rating,
        review: user_media.review,
        is_favorite: user_media.is_favorite,
        started_at: user_media.started_at,
        completed_at: user_media.completed_at,
        release_date: media.release_date,
    }))
}

async fn update_tracking(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<Uuid>,
    body: web::Json<UpdateTrackingRequest>,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    let tracking_id = path.into_inner();
    body.validate()?;
    let data = body.into_inner();

    let today = Utc::now().date_naive();
    validate_supplied_dates(data.started_at, data.completed_at, today)?;

    let mut tx = pool.begin().await?;
    // All tracking mutations use the same first lock. In particular, this
    // keeps row locks and history quota locks ordered consistently with imports.
    quota::lock_tracking_writes(&mut tx, user_id).await?;
    let current = sqlx::query_as::<_, crate::models::UserMedia>(
        "SELECT * FROM user_media WHERE id = $1 AND user_id = $2 FOR UPDATE",
    )
    .bind(tracking_id)
    .bind(user_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::NotFound("Tracking entry not found".to_string()))?;

    let effective_status = data
        .status
        .as_deref()
        .unwrap_or(&current.status)
        .to_string();
    if data.completed_at.is_some() && effective_status != "completed" {
        return Err(AppError::BadRequest(
            "completed_at requires completed status".to_string(),
        ));
    }

    let effective_started_at = data
        .started_at
        .or(current.started_at)
        .or_else(|| matches!(effective_status.as_str(), "watching" | "completed").then_some(today));
    let effective_completed_at = (effective_status == "completed")
        .then(|| data.completed_at.or(current.completed_at).unwrap_or(today));

    if let (Some(started_at), Some(completed_at)) = (effective_started_at, effective_completed_at) {
        if completed_at < started_at {
            return Err(AppError::BadRequest(
                "completed_at cannot be before started_at".to_string(),
            ));
        }
    }

    let entering_completed = current.status != "completed" && effective_status == "completed";
    let rating_supplied = data.rating.is_some();
    let rating = data.rating.flatten();
    let review_supplied = data.review.is_some();
    let review = data.review.flatten();
    let updated = sqlx::query_as::<_, crate::models::UserMedia>(
        r#"UPDATE user_media SET
            status = $3,
            rating = CASE WHEN $4 THEN $5 ELSE rating END,
            review = CASE WHEN $6 THEN $7 ELSE review END,
            is_favorite = COALESCE($8, is_favorite),
            started_at = $9,
            completed_at = $10,
            updated_at = NOW()
        WHERE id = $1 AND user_id = $2
        RETURNING *"#,
    )
    .bind(tracking_id)
    .bind(user_id)
    .bind(&effective_status)
    .bind(rating_supplied)
    .bind(rating)
    .bind(review_supplied)
    .bind(&review)
    .bind(data.is_favorite)
    .bind(effective_started_at)
    .bind(effective_completed_at)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::NotFound("Tracking entry not found".to_string()))?;

    let media = sqlx::query_as::<_, crate::models::Media>("SELECT * FROM media WHERE id = $1")
        .bind(updated.media_id)
        .fetch_one(&mut *tx)
        .await?;

    if entering_completed {
        record_completion_history(&mut tx, user_id, media.id, &media.media_type).await?;
    }
    tx.commit().await?;

    Ok(HttpResponse::Ok().json(TrackingResponse {
        id: updated.id,
        media_id: media.id,
        tmdb_id: media.tmdb_id,
        media_type: media.media_type,
        title: media.title,
        poster_path: media.poster_path,
        status: updated.status,
        rating: updated.rating,
        review: updated.review,
        is_favorite: updated.is_favorite,
        started_at: updated.started_at,
        completed_at: updated.completed_at,
        release_date: media.release_date,
    }))
}

fn validate_supplied_dates(
    started_at: Option<NaiveDate>,
    completed_at: Option<NaiveDate>,
    today: NaiveDate,
) -> Result<(), AppError> {
    if started_at.is_some_and(|date| date > today) || completed_at.is_some_and(|date| date > today)
    {
        return Err(AppError::BadRequest(
            "Tracking dates cannot be in the future".to_string(),
        ));
    }
    Ok(())
}

async fn record_completion_history(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    media_id: Uuid,
    media_type: &str,
) -> Result<(), AppError> {
    let history_count = quota::lock_and_count_history(tx, user_id).await?;

    if media_type == "movie" {
        let already_recorded = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(
                SELECT 1 FROM watch_history
                WHERE user_id = $1 AND media_id = $2 AND episode_id IS NULL
            )",
        )
        .bind(user_id)
        .bind(media_id)
        .fetch_one(&mut **tx)
        .await?;
        quota::ensure_history_capacity(history_count, if already_recorded { 0 } else { 1 })?;

        sqlx::query(
            r#"INSERT INTO watch_history (user_id, media_id, watched_at)
            SELECT $1, $2, NOW()
            WHERE NOT EXISTS (
                SELECT 1 FROM watch_history
                WHERE user_id = $1 AND media_id = $2 AND episode_id IS NULL
            )"#,
        )
        .bind(user_id)
        .bind(media_id)
        .execute(&mut **tx)
        .await?;
        return Ok(());
    }

    // Deliberately the server's own date, not `available_through!()`. Here the
    // user picked a *status*, not episodes: the set is derived, so a generous
    // bound does not unblock anything they asked for, it invents watch history
    // for an episode that has not aired.
    let (missing_episodes, catalog_episode_count) = sqlx::query_as::<_, (i64, i64)>(
        r#"SELECT
            COUNT(*) FILTER (
                WHERE episode_has_aired(e.air_date, m.origin_country, m.streaming_only)
                AND NOT EXISTS (
                    SELECT 1 FROM watch_history wh
                    WHERE wh.user_id = $1 AND wh.media_id = $2 AND wh.episode_id = e.id
                )
            ),
            COUNT(*)
        FROM episodes e
        JOIN seasons s ON e.season_id = s.id
        JOIN media m ON m.id = s.media_id
        WHERE s.media_id = $2 AND s.season_number > 0
        "#,
    )
    .bind(user_id)
    .bind(media_id)
    .fetch_one(&mut **tx)
    .await?;
    let has_title_history = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(
            SELECT 1 FROM watch_history WHERE user_id = $1 AND media_id = $2
        )",
    )
    .bind(user_id)
    .bind(media_id)
    .fetch_one(&mut **tx)
    .await?;
    let fallback_rows = if catalog_episode_count == 0 && !has_title_history {
        1
    } else {
        0
    };
    quota::ensure_history_capacity(history_count, missing_episodes + fallback_rows)?;

    // Must agree with the count above, or the quota check reserves room for a
    // different number of rows than this inserts.
    let inserted = sqlx::query(
        r#"INSERT INTO watch_history (user_id, media_id, episode_id, watched_at)
        SELECT $1, $2, e.id, NOW()
        FROM episodes e
        JOIN seasons s ON e.season_id = s.id
        JOIN media m ON m.id = s.media_id
        WHERE s.media_id = $2 AND s.season_number > 0
        AND episode_has_aired(e.air_date, m.origin_country, m.streaming_only)
        AND NOT EXISTS (
            SELECT 1 FROM watch_history wh
            WHERE wh.user_id = $1 AND wh.media_id = $2 AND wh.episode_id = e.id
        )"#,
    )
    .bind(user_id)
    .bind(media_id)
    .execute(&mut **tx)
    .await?
    .rows_affected();

    if inserted == 0 {
        sqlx::query(
            r#"INSERT INTO watch_history (user_id, media_id, watched_at)
            SELECT $1, $2, NOW()
            WHERE NOT EXISTS (
                SELECT 1 FROM watch_history
                WHERE user_id = $1 AND media_id = $2
            )"#,
        )
        .bind(user_id)
        .bind(media_id)
        .execute(&mut **tx)
        .await?;
    }

    Ok(())
}

async fn delete_tracking(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<Uuid>,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    let tracking_id = path.into_inner();

    let mut tx = pool.begin().await?;
    quota::lock_tracking_writes(&mut tx, user_id).await?;
    let result = sqlx::query("DELETE FROM user_media WHERE id = $1 AND user_id = $2")
        .bind(tracking_id)
        .bind(user_id)
        .execute(&mut *tx)
        .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("Tracking entry not found".to_string()));
    }
    tx.commit().await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({"message": "Deleted successfully"})))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_folded_letter_has_its_replacement() {
        // translate() drops a letter with no counterpart instead of keeping
        // it, so one missing character would quietly change what matches.
        assert_eq!(FOLD_FROM.chars().count(), FOLD_TO.chars().count());
        assert!(FOLD_TO.chars().all(|letter| letter.is_ascii_lowercase()));
    }

    #[test]
    fn a_search_is_folded_the_way_names_are() {
        assert_eq!(fold("Sărbători ȘI Pokémon"), "sarbatori si pokemon");
        assert_eq!(fold("SHŌGUN"), "shogun");
        // Scripts without a plain-letter spelling are left as they are.
        assert_eq!(fold("呪術廻戦"), "呪術廻戦");
    }

    #[test]
    fn every_sort_the_api_accepts_has_its_own_order() {
        let orders = VALID_TRACKING_SORTS
            .iter()
            .map(|sort| library_order(Some(sort)))
            .collect::<HashSet<_>>();
        assert_eq!(orders.len(), VALID_TRACKING_SORTS.len());
        assert_eq!(library_order(None), library_order(Some("updated")));
        for order in orders {
            assert!(
                order.ends_with("id") || order.ends_with("id DESC"),
                "{order}"
            );
        }
    }

    #[test]
    fn facets_name_genres_in_the_readers_language_most_common_first() {
        let rows = vec![
            ("status".to_string(), Some("completed".to_string()), None, 3),
            ("media_type".to_string(), Some("tv".to_string()), None, 4),
            (
                "genre".to_string(),
                Some("18".to_string()),
                Some("Drama".to_string()),
                2,
            ),
            (
                "genre".to_string(),
                Some("16".to_string()),
                Some("Animation".to_string()),
                4,
            ),
            // Not in the hub table: TMDB's own name is all there is.
            (
                "genre".to_string(),
                Some("99999".to_string()),
                Some("Newgenre".to_string()),
                1,
            ),
            (
                "genre".to_string(),
                Some("not a number".to_string()),
                None,
                9,
            ),
            ("anime".to_string(), None, None, 2),
            ("favorite".to_string(), None, None, 1),
            ("total".to_string(), None, None, 4),
        ];
        let facets = facets_from_rows(rows, Language::Ro);
        assert_eq!(facets.total, 4);
        assert_eq!(facets.anime, 2);
        assert_eq!(facets.favorites, 1);
        assert_eq!(facets.statuses.get("completed"), Some(&3));
        assert_eq!(facets.media_types.get("tv"), Some(&4));
        let genres = facets
            .genres
            .iter()
            .map(|genre| (genre.id, genre.name.as_str(), genre.count))
            .collect::<Vec<_>>();
        assert_eq!(
            genres,
            vec![
                (16, "Animație", 4),
                (18, "Dramă", 2),
                (99999, "Newgenre", 1)
            ]
        );
    }

    #[test]
    fn only_a_non_empty_search_filters() {
        for q in [None, Some(""), Some("   ")] {
            let params = TrackingQueryParams {
                q: q.map(str::to_string),
                ..Default::default()
            };
            assert_eq!(LibraryFilter::new(&params).title, None, "{q:?}");
        }
        let params = TrackingQueryParams {
            q: Some("  naruto ".to_string()),
            genre: Some("anime".to_string()),
            ..Default::default()
        };
        let filter = LibraryFilter::new(&params);
        assert_eq!(filter.title.as_deref(), Some("naruto"));
        let params = TrackingQueryParams {
            q: Some(" Sărbători ".to_string()),
            ..Default::default()
        };
        assert_eq!(
            LibraryFilter::new(&params).title.as_deref(),
            Some("sarbatori")
        );
        assert!(filter.anime);
        assert_eq!(filter.genre_id, None);
    }
}
