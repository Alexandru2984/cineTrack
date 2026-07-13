use chrono::NaiveDate;
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

use crate::dto::media::{DiscoveryResponse, TmdbSearchResult};
use crate::services::catalog;

const SECTION_SIZE: i64 = 12;
const CANDIDATES_PER_TYPE: i64 = 500;
const MAX_PREFERENCES: i64 = 20;

#[derive(FromRow)]
struct PreferenceRow {
    genre_id: String,
    genre_name: String,
    weight: f64,
}

#[derive(FromRow)]
struct DiscoveryRow {
    tmdb_id: i32,
    media_type: String,
    title: String,
    original_title: Option<String>,
    overview: Option<String>,
    poster_path: Option<String>,
    backdrop_path: Option<String>,
    release_date: Option<NaiveDate>,
    vote_average: Option<f64>,
    affinity: f64,
}

impl DiscoveryRow {
    fn into_search_result(self) -> TmdbSearchResult {
        let is_movie = self.media_type == "movie";
        TmdbSearchResult {
            id: self.tmdb_id,
            title: is_movie.then_some(self.title.clone()),
            name: (!is_movie).then_some(self.title),
            original_title: is_movie.then_some(self.original_title.clone()).flatten(),
            original_name: (!is_movie).then_some(self.original_title).flatten(),
            overview: self.overview,
            poster_path: self.poster_path,
            backdrop_path: self.backdrop_path,
            release_date: is_movie
                .then(|| self.release_date.map(|date| date.to_string()))
                .flatten(),
            first_air_date: (!is_movie)
                .then(|| self.release_date.map(|date| date.to_string()))
                .flatten(),
            vote_average: self.vote_average,
            media_type: Some(self.media_type),
            genre_ids: None,
        }
    }
}

async fn load_preferences(pool: &PgPool, user_id: Uuid) -> Result<Vec<PreferenceRow>, sqlx::Error> {
    sqlx::query_as::<_, PreferenceRow>(
        r#"WITH weighted_genres AS (
            SELECT
                NULLIF(btrim(genre.value ->> 'id'), '') AS genre_id,
                NULLIF(btrim(genre.value ->> 'name'), '') AS genre_name,
                (
                    CASE WHEN tracked.is_favorite THEN 4 ELSE 0 END
                    + CASE
                        WHEN tracked.rating >= 8 THEN 3
                        WHEN tracked.rating >= 6 THEN 1
                        ELSE 0
                    END
                    + CASE
                        WHEN tracked.status = 'completed' THEN 2
                        WHEN tracked.status = 'watching' THEN 1
                        ELSE 0
                    END
                )::double precision AS weight
            FROM user_media tracked
            JOIN media seed
              ON seed.id = tracked.media_id
            CROSS JOIN LATERAL jsonb_array_elements(
                CASE
                    WHEN jsonb_typeof(seed.genres) = 'array' THEN seed.genres
                    ELSE '[]'::jsonb
                END
            ) AS genre(value)
            WHERE tracked.user_id = $1
              AND (
                  tracked.is_favorite
                  OR tracked.rating >= 6
                  OR tracked.status IN ('completed', 'watching')
              )
        )
        SELECT
            genre_id,
            MIN(genre_name) AS genre_name,
            SUM(weight)::double precision AS weight
        FROM weighted_genres
        WHERE genre_id IS NOT NULL
          AND genre_name IS NOT NULL
        GROUP BY genre_id
        ORDER BY weight DESC, genre_name
        LIMIT $2"#,
    )
    .bind(user_id)
    .bind(MAX_PREFERENCES)
    .fetch_all(pool)
    .await
}

async fn load_recommendations(
    pool: &PgPool,
    user_id: Uuid,
    language_code: Option<&str>,
    region_code: Option<&str>,
    preferences: &[PreferenceRow],
) -> Result<Vec<DiscoveryRow>, sqlx::Error> {
    let genre_ids = preferences
        .iter()
        .map(|preference| preference.genre_id.clone())
        .collect::<Vec<_>>();
    let weights = preferences
        .iter()
        .map(|preference| preference.weight)
        .collect::<Vec<_>>();

    sqlx::query_as::<_, DiscoveryRow>(
        r#"WITH localized_media AS MATERIALIZED (
            SELECT DISTINCT ON (aliases.media_id)
                aliases.media_id,
                aliases.title
            FROM media_title_aliases aliases
            WHERE $1::text IS NOT NULL
              AND aliases.kind = 'translation'
              AND aliases.language_code = $1
            ORDER BY
                aliases.media_id,
                CASE
                    WHEN $2::text IS NOT NULL AND aliases.region_code = $2 THEN 0
                    WHEN aliases.region_code = '' THEN 1
                    ELSE 2
                END,
                aliases.title
        ), movie_candidates AS MATERIALIZED (
            SELECT
                media.id,
                media.tmdb_id,
                media.media_type,
                COALESCE(localized.title, media.title) AS title,
                media.original_title,
                media.overview,
                media.poster_path,
                media.backdrop_path,
                media.release_date,
                media.tmdb_vote_average AS vote_average,
                media.genres,
                inventory.popularity
            FROM media
            JOIN catalog_external_ids inventory
              ON inventory.tmdb_id = media.tmdb_id
             AND inventory.media_type = media.media_type
            LEFT JOIN localized_media localized
              ON localized.media_id = media.id
            WHERE media.media_type = 'movie'
              AND media.metadata_level = 'detail'
              AND media.poster_path IS NOT NULL
              AND inventory.adult = FALSE
              AND inventory.video = FALSE
              AND NOT EXISTS (
                  SELECT 1
                  FROM user_media tracked
                  WHERE tracked.user_id = $3
                    AND tracked.media_id = media.id
              )
            ORDER BY inventory.popularity DESC, media.tmdb_id
            LIMIT $6
        ), tv_candidates AS MATERIALIZED (
            SELECT
                media.id,
                media.tmdb_id,
                media.media_type,
                COALESCE(localized.title, media.title) AS title,
                media.original_title,
                media.overview,
                media.poster_path,
                media.backdrop_path,
                media.release_date,
                media.tmdb_vote_average AS vote_average,
                media.genres,
                inventory.popularity
            FROM media
            JOIN catalog_external_ids inventory
              ON inventory.tmdb_id = media.tmdb_id
             AND inventory.media_type = media.media_type
            LEFT JOIN localized_media localized
              ON localized.media_id = media.id
            WHERE media.media_type = 'tv'
              AND media.metadata_level = 'detail'
              AND media.poster_path IS NOT NULL
              AND inventory.adult = FALSE
              AND inventory.video = FALSE
              AND NOT EXISTS (
                  SELECT 1
                  FROM user_media tracked
                  WHERE tracked.user_id = $3
                    AND tracked.media_id = media.id
              )
            ORDER BY inventory.popularity DESC, media.tmdb_id
            LIMIT $6
        ), candidate_pool AS (
            SELECT * FROM movie_candidates
            UNION ALL
            SELECT * FROM tv_candidates
        ), preferences AS (
            SELECT genre_id, weight
            FROM unnest($4::text[], $5::double precision[])
                AS preference(genre_id, weight)
        )
        SELECT
            candidate.tmdb_id,
            candidate.media_type,
            candidate.title,
            candidate.original_title,
            candidate.overview,
            candidate.poster_path,
            candidate.backdrop_path,
            candidate.release_date,
            candidate.vote_average,
            COALESCE((
                SELECT SUM(preference.weight)
                FROM (
                    SELECT DISTINCT genre.value ->> 'id' AS genre_id
                    FROM jsonb_array_elements(
                        CASE
                            WHEN jsonb_typeof(candidate.genres) = 'array'
                                THEN candidate.genres
                            ELSE '[]'::jsonb
                        END
                    ) AS genre(value)
                ) AS candidate_genre
                JOIN preferences preference
                  USING (genre_id)
            ), 0)::double precision AS affinity
        FROM candidate_pool candidate
        ORDER BY
            affinity DESC,
            candidate.popularity DESC,
            candidate.vote_average DESC NULLS LAST,
            candidate.tmdb_id
        LIMIT $7"#,
    )
    .bind(language_code)
    .bind(region_code)
    .bind(user_id)
    .bind(&genre_ids)
    .bind(&weights)
    .bind(CANDIDATES_PER_TYPE)
    .bind(SECTION_SIZE)
    .fetch_all(pool)
    .await
}

async fn load_popular(
    pool: &PgPool,
    language_code: Option<&str>,
    region_code: Option<&str>,
) -> Result<Vec<DiscoveryRow>, sqlx::Error> {
    sqlx::query_as::<_, DiscoveryRow>(
        r#"WITH localized_media AS MATERIALIZED (
            SELECT DISTINCT ON (aliases.media_id)
                aliases.media_id,
                aliases.title
            FROM media_title_aliases aliases
            WHERE $1::text IS NOT NULL
              AND aliases.kind = 'translation'
              AND aliases.language_code = $1
            ORDER BY
                aliases.media_id,
                CASE
                    WHEN $2::text IS NOT NULL AND aliases.region_code = $2 THEN 0
                    WHEN aliases.region_code = '' THEN 1
                    ELSE 2
                END,
                aliases.title
        )
        SELECT
            popular.tmdb_id,
            popular.media_type,
            popular.title,
            popular.original_title,
            popular.overview,
            popular.poster_path,
            popular.backdrop_path,
            popular.release_date,
            popular.vote_average,
            0::double precision AS affinity
        FROM (
            (
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
                    inventory.popularity
                FROM catalog_external_ids inventory
                JOIN media
                  ON media.tmdb_id = inventory.tmdb_id
                 AND media.media_type = inventory.media_type
                LEFT JOIN localized_media localized
                  ON localized.media_id = media.id
                WHERE inventory.media_type = 'movie'
                  AND inventory.adult = FALSE
                  AND inventory.video = FALSE
                  AND media.metadata_level = 'detail'
                  AND media.poster_path IS NOT NULL
                ORDER BY
                    inventory.popularity DESC,
                    media.tmdb_vote_average DESC NULLS LAST,
                    media.tmdb_id
                LIMIT $3
            )
            UNION ALL
            (
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
                    inventory.popularity
                FROM catalog_external_ids inventory
                JOIN media
                  ON media.tmdb_id = inventory.tmdb_id
                 AND media.media_type = inventory.media_type
                LEFT JOIN localized_media localized
                  ON localized.media_id = media.id
                WHERE inventory.media_type = 'tv'
                  AND inventory.adult = FALSE
                  AND inventory.video = FALSE
                  AND media.metadata_level = 'detail'
                  AND media.poster_path IS NOT NULL
                ORDER BY
                    inventory.popularity DESC,
                    media.tmdb_vote_average DESC NULLS LAST,
                    media.tmdb_id
                LIMIT $3
            )
        ) AS popular
        ORDER BY
            popular.media_type,
            popular.popularity DESC,
            popular.vote_average DESC NULLS LAST,
            popular.tmdb_id"#,
    )
    .bind(language_code)
    .bind(region_code)
    .bind(SECTION_SIZE)
    .fetch_all(pool)
    .await
}

pub async fn load_discovery(
    pool: &PgPool,
    user_id: Uuid,
    language: Option<&str>,
) -> Result<DiscoveryResponse, sqlx::Error> {
    let (language_code, region_code) = catalog::locale_parts(language);
    let preferences = load_preferences(pool, user_id).await?;
    let recommendation_rows = load_recommendations(
        pool,
        user_id,
        language_code.as_deref(),
        region_code.as_deref(),
        &preferences,
    )
    .await?;
    let popular_rows = load_popular(pool, language_code.as_deref(), region_code.as_deref()).await?;

    let personalized = recommendation_rows.iter().any(|row| row.affinity > 0.0);
    let recommendation_basis = preferences
        .iter()
        .take(3)
        .map(|preference| preference.genre_name.clone())
        .collect();
    let recommendations = recommendation_rows
        .into_iter()
        .map(DiscoveryRow::into_search_result)
        .collect();
    let (popular_movies, popular_shows) = popular_rows
        .into_iter()
        .map(DiscoveryRow::into_search_result)
        .partition(|result| result.media_type.as_deref() == Some("movie"));

    Ok(DiscoveryResponse {
        recommendations,
        personalized,
        recommendation_basis,
        popular_movies,
        popular_shows,
    })
}
