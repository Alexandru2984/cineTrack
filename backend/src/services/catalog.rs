use chrono::NaiveDate;
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

use crate::dto::media::{TmdbSearchResponse, TmdbSearchResult};

const SEARCH_PAGE_SIZE: i64 = 20;
const MIN_LOCAL_QUERY_CHARS: usize = 3;

#[derive(FromRow)]
struct LocalSearchRow {
    tmdb_id: i32,
    media_type: String,
    title: String,
    original_title: Option<String>,
    overview: Option<String>,
    poster_path: Option<String>,
    backdrop_path: Option<String>,
    release_date: Option<NaiveDate>,
    vote_average: Option<f64>,
    total_count: i64,
}

fn normalize_query(query: &str) -> String {
    query
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn empty_response(page: u32) -> TmdbSearchResponse {
    TmdbSearchResponse {
        page,
        total_pages: 0,
        total_results: 0,
        results: Vec::new(),
    }
}

pub(crate) fn locale_parts(language: Option<&str>) -> (Option<String>, Option<String>) {
    let Some(language) = language else {
        return (None, None);
    };
    let mut parts = language.split('-');
    let code = parts.next().unwrap_or_default();
    if code.len() != 2 || !code.bytes().all(|byte| byte.is_ascii_alphabetic()) {
        return (None, None);
    }
    let region = parts.next().and_then(|value| {
        (parts.next().is_none()
            && value.len() == 2
            && value.bytes().all(|byte| byte.is_ascii_alphabetic()))
        .then(|| value.to_ascii_uppercase())
    });
    (Some(code.to_ascii_lowercase()), region)
}

pub async fn search_local(
    pool: &PgPool,
    query: &str,
    media_type: Option<&str>,
    page: u32,
    language: Option<&str>,
) -> Result<TmdbSearchResponse, sqlx::Error> {
    let normalized = normalize_query(query);
    if normalized.chars().count() < MIN_LOCAL_QUERY_CHARS {
        return Ok(empty_response(page));
    }
    let offset = i64::from(page.saturating_sub(1)) * SEARCH_PAGE_SIZE;
    let (language_code, region_code) = locale_parts(language);
    let rows = sqlx::query_as::<_, LocalSearchRow>(
        r#"WITH localized_media AS MATERIALIZED (
            SELECT DISTINCT ON (aliases.media_id)
                aliases.media_id,
                aliases.title
            FROM media_title_aliases aliases
            WHERE $5::text IS NOT NULL
              AND aliases.kind = 'translation'
              AND aliases.language_code = $5
            ORDER BY
                aliases.media_id,
                CASE
                    WHEN $6::text IS NOT NULL AND aliases.region_code = $6 THEN 0
                    WHEN aliases.region_code = '' THEN 1
                    ELSE 2
                END,
                aliases.title
        ), raw_candidates AS (
            SELECT
                ids.tmdb_id,
                ids.media_type,
                COALESCE(localized.title, media.title, titles.title) AS title,
                COALESCE(media.original_title, titles.title) AS original_title,
                media.overview,
                media.poster_path,
                media.backdrop_path,
                media.release_date,
                media.tmdb_vote_average AS vote_average,
                CASE
                    WHEN lower(titles.title) = $1 THEN 100.0
                    WHEN lower(titles.title) LIKE $1 || '%' THEN 80.0
                    ELSE 50.0
                END
                + similarity(lower(titles.title), $1) * 10
                + LEAST(
                    LN(1.0 + GREATEST(ids.popularity::double precision, 0.0)),
                    10.0
                ) AS rank,
                1 AS source_priority
            FROM catalog_external_titles titles
            JOIN catalog_external_ids ids
              USING (media_type, tmdb_id)
            LEFT JOIN media
              ON media.tmdb_id = ids.tmdb_id
             AND media.media_type = ids.media_type
            LEFT JOIN localized_media localized
              ON localized.media_id = media.id
            WHERE ids.adult = FALSE
              AND ids.video = FALSE
              AND ($2::text IS NULL OR ids.media_type = $2)
              AND (
                  lower(titles.title) % $1
                  OR lower(titles.title) LIKE $1 || '%'
              )
            UNION ALL
            SELECT
                media.tmdb_id,
                media.media_type,
                COALESCE(localized.title, media.title) AS title,
                media.original_title,
                media.overview,
                media.poster_path,
                media.backdrop_path,
                media.release_date,
                media.tmdb_vote_average AS vote_average,
                CASE
                    WHEN lower(media.title) = $1 THEN 105.0
                    WHEN lower(media.original_title) = $1 THEN 100.0
                    WHEN lower(media.title) LIKE $1 || '%' THEN 85.0
                    WHEN lower(media.original_title) LIKE $1 || '%' THEN 80.0
                    ELSE 55.0
                END
                + GREATEST(
                    similarity(lower(media.title), $1),
                    COALESCE(similarity(lower(media.original_title), $1), 0)
                ) * 10 AS rank,
                2 AS source_priority
            FROM media
            LEFT JOIN catalog_external_ids ids
              ON ids.tmdb_id = media.tmdb_id
             AND ids.media_type = media.media_type
            LEFT JOIN localized_media localized
              ON localized.media_id = media.id
            WHERE (ids.tmdb_id IS NULL OR (ids.adult = FALSE AND ids.video = FALSE))
              AND ($2::text IS NULL OR media.media_type = $2)
              AND (
                  lower(media.title) % $1
                  OR lower(media.original_title) % $1
                  OR lower(media.title) LIKE $1 || '%'
                  OR lower(media.original_title) LIKE $1 || '%'
              )
            UNION ALL
            SELECT
                media.tmdb_id,
                media.media_type,
                COALESCE(localized.title, media.title) AS title,
                media.original_title,
                media.overview,
                media.poster_path,
                media.backdrop_path,
                media.release_date,
                media.tmdb_vote_average AS vote_average,
                CASE
                    WHEN lower(aliases.title) = $1 THEN 103.0
                    WHEN lower(aliases.title) LIKE $1 || '%' THEN 83.0
                    ELSE 53.0
                END
                + similarity(lower(aliases.title), $1) * 10
                + LEAST(
                    LN(1.0 + GREATEST(COALESCE(ids.popularity, 0)::double precision, 0.0)),
                    10.0
                ) AS rank,
                3 AS source_priority
            FROM media_title_aliases aliases
            JOIN media
              ON media.id = aliases.media_id
            LEFT JOIN catalog_external_ids ids
              ON ids.tmdb_id = media.tmdb_id
             AND ids.media_type = media.media_type
            LEFT JOIN localized_media localized
              ON localized.media_id = media.id
            WHERE (ids.tmdb_id IS NULL OR (ids.adult = FALSE AND ids.video = FALSE))
              AND ($2::text IS NULL OR media.media_type = $2)
              AND (
                  lower(aliases.title) % $1
                  OR lower(aliases.title) LIKE $1 || '%'
              )
        ), deduplicated AS (
            SELECT DISTINCT ON (tmdb_id, media_type)
                tmdb_id,
                media_type,
                title,
                original_title,
                overview,
                poster_path,
                backdrop_path,
                release_date,
                vote_average,
                rank
            FROM raw_candidates
            ORDER BY tmdb_id, media_type, rank DESC, source_priority DESC
        )
        SELECT
            tmdb_id,
            media_type,
            title,
            original_title,
            overview,
            poster_path,
            backdrop_path,
            release_date,
            vote_average,
            COUNT(*) OVER () AS total_count
        FROM deduplicated
        ORDER BY rank DESC, vote_average DESC NULLS LAST, release_date DESC NULLS LAST, tmdb_id
        LIMIT $3 OFFSET $4"#,
    )
    .bind(&normalized)
    .bind(media_type)
    .bind(SEARCH_PAGE_SIZE)
    .bind(offset)
    .bind(language_code.as_deref())
    .bind(region_code.as_deref())
    .fetch_all(pool)
    .await?;

    let total = rows.first().map_or(0, |row| row.total_count.max(0));
    let total_results = u32::try_from(total).unwrap_or(u32::MAX);
    let total_pages = total_results.div_ceil(SEARCH_PAGE_SIZE as u32);
    let results = rows
        .into_iter()
        .map(|row| {
            let (title, name, original_title, original_name, release_date, first_air_date) =
                if row.media_type == "movie" {
                    (
                        Some(row.title),
                        None,
                        row.original_title,
                        None,
                        row.release_date.map(|date| date.to_string()),
                        None,
                    )
                } else {
                    (
                        None,
                        Some(row.title),
                        None,
                        row.original_title,
                        None,
                        row.release_date.map(|date| date.to_string()),
                    )
                };
            TmdbSearchResult {
                id: row.tmdb_id,
                title,
                name,
                original_title,
                original_name,
                overview: row.overview,
                poster_path: row.poster_path,
                backdrop_path: row.backdrop_path,
                release_date,
                first_air_date,
                vote_average: row.vote_average,
                media_type: Some(row.media_type),
                genre_ids: None,
            }
        })
        .collect();

    Ok(TmdbSearchResponse {
        page,
        total_pages,
        total_results,
        results,
    })
}

pub async fn localized_title(
    pool: &PgPool,
    media_id: Uuid,
    language: Option<&str>,
) -> Result<Option<String>, sqlx::Error> {
    let (Some(language_code), region_code) = locale_parts(language) else {
        return Ok(None);
    };
    sqlx::query_scalar::<_, String>(
        r#"SELECT title
        FROM media_title_aliases
        WHERE media_id = $1
          AND kind = 'translation'
          AND language_code = $2
        ORDER BY
            CASE
                WHEN $3::text IS NOT NULL AND region_code = $3 THEN 0
                WHEN region_code = '' THEN 1
                ELSE 2
            END,
            title
        LIMIT 1"#,
    )
    .bind(media_id)
    .bind(language_code)
    .bind(region_code.as_deref())
    .fetch_optional(pool)
    .await
}

pub async fn cache_search_results(
    pool: &PgPool,
    response: &TmdbSearchResponse,
    requested_type: Option<&str>,
) -> Result<u64, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let mut affected = 0;
    for result in response.results.iter().take(SEARCH_PAGE_SIZE as usize) {
        let media_type = match result.media_type.as_deref().or(requested_type) {
            Some(media_type @ ("movie" | "tv")) => media_type,
            _ => continue,
        };
        let title = if media_type == "movie" {
            result.title.as_deref()
        } else {
            result.name.as_deref()
        };
        let Some(title) = title.filter(|title| !title.trim().is_empty()) else {
            continue;
        };
        let original_title = if media_type == "movie" {
            result.original_title.as_deref()
        } else {
            result.original_name.as_deref()
        };
        let date = if media_type == "movie" {
            result.release_date.as_deref()
        } else {
            result.first_air_date.as_deref()
        }
        .and_then(|date| NaiveDate::parse_from_str(date, "%Y-%m-%d").ok());

        affected += sqlx::query(
            r#"INSERT INTO media
                (tmdb_id, media_type, title, original_title, overview, poster_path,
                 backdrop_path, release_date, tmdb_vote_average, tmdb_cached_at,
                 last_accessed_at, metadata_level)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW(), 'summary')
            ON CONFLICT (tmdb_id, media_type) DO UPDATE SET
                title = EXCLUDED.title,
                original_title = EXCLUDED.original_title,
                overview = EXCLUDED.overview,
                poster_path = EXCLUDED.poster_path,
                backdrop_path = EXCLUDED.backdrop_path,
                release_date = EXCLUDED.release_date,
                tmdb_vote_average = EXCLUDED.tmdb_vote_average,
                tmdb_cached_at = NOW(),
                last_accessed_at = NOW()
            WHERE media.metadata_level = 'summary'
              AND media.last_accessed_at < NOW() - INTERVAL '1 hour'"#,
        )
        .bind(result.id)
        .bind(media_type)
        .bind(title)
        .bind(original_title)
        .bind(&result.overview)
        .bind(&result.poster_path)
        .bind(&result.backdrop_path)
        .bind(date)
        .bind(result.vote_average)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    }
    tx.commit().await?;
    Ok(affected)
}

pub fn has_local_results(response: &TmdbSearchResponse) -> bool {
    !response.results.is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_queries_are_normalized() {
        assert_eq!(normalize_query("  The   Matrix "), "the matrix");
    }

    #[test]
    fn requested_locales_are_canonicalized() {
        assert_eq!(
            locale_parts(Some("ro-ro")),
            (Some("ro".to_string()), Some("RO".to_string()))
        );
        assert_eq!(locale_parts(Some("invalid")), (None, None));
    }

    #[test]
    fn any_local_match_skips_the_provider() {
        let mut response = empty_response(1);
        assert!(!has_local_results(&response));
        response.results.push(TmdbSearchResult {
            id: 1,
            title: Some("Title".to_string()),
            name: None,
            original_title: None,
            original_name: None,
            overview: None,
            poster_path: None,
            backdrop_path: None,
            release_date: None,
            first_air_date: None,
            vote_average: None,
            media_type: Some("movie".to_string()),
            genre_ids: None,
        });
        assert!(has_local_results(&response));
    }
}
