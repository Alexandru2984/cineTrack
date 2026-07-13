use chrono::NaiveDate;
use sqlx::{FromRow, PgPool};

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

pub async fn search_local(
    pool: &PgPool,
    query: &str,
    media_type: Option<&str>,
    page: u32,
) -> Result<TmdbSearchResponse, sqlx::Error> {
    let normalized = normalize_query(query);
    if normalized.chars().count() < MIN_LOCAL_QUERY_CHARS {
        return Ok(empty_response(page));
    }
    let offset = i64::from(page.saturating_sub(1)) * SEARCH_PAGE_SIZE;
    let rows = sqlx::query_as::<_, LocalSearchRow>(
        r#"WITH ranked AS (
            SELECT
                tmdb_id,
                media_type,
                title,
                original_title,
                overview,
                poster_path,
                backdrop_path,
                release_date,
                tmdb_vote_average AS vote_average,
                CASE
                    WHEN lower(title) = $1 THEN 100.0
                    WHEN lower(original_title) = $1 THEN 95.0
                    WHEN lower(title) LIKE $1 || '%' THEN 80.0
                    WHEN lower(original_title) LIKE $1 || '%' THEN 75.0
                    ELSE 50.0
                END
                + GREATEST(
                    similarity(lower(title), $1),
                    COALESCE(similarity(lower(original_title), $1), 0)
                ) * 10 AS rank
            FROM media
            WHERE ($2::text IS NULL OR media_type = $2)
              AND (
                  lower(title) % $1
                  OR lower(original_title) % $1
                  OR lower(title) LIKE $1 || '%'
                  OR lower(original_title) LIKE $1 || '%'
              )
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
        FROM ranked
        ORDER BY rank DESC, vote_average DESC NULLS LAST, release_date DESC NULLS LAST, tmdb_id
        LIMIT $3 OFFSET $4"#,
    )
    .bind(&normalized)
    .bind(media_type)
    .bind(SEARCH_PAGE_SIZE)
    .bind(offset)
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

pub fn page_is_local(response: &TmdbSearchResponse) -> bool {
    response.results.len() == SEARCH_PAGE_SIZE as usize
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_queries_are_normalized() {
        assert_eq!(normalize_query("  The   Matrix "), "the matrix");
    }

    #[test]
    fn only_full_pages_skip_the_provider() {
        let mut response = empty_response(1);
        assert!(!page_is_local(&response));
        response.results = (0..SEARCH_PAGE_SIZE)
            .map(|id| TmdbSearchResult {
                id: id as i32 + 1,
                title: Some(format!("Title {id}")),
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
            })
            .collect();
        assert!(page_is_local(&response));
    }
}
