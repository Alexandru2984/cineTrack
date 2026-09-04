use std::collections::HashSet;

use crate::errors::AppError;
use chrono::{NaiveDate, Utc};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

use crate::dto::media::{BecauseYouWatched, DiscoveryResponse, TmdbSearchResult};
use crate::services::catalog;
use crate::services::tmdb::TmdbService;

const SECTION_SIZE: i64 = 12;
const CANDIDATES_PER_TYPE: i64 = 500;
const MAX_PREFERENCES: i64 = 20;
const BECAUSE_YOU_WATCHED_SIZE: usize = 12;

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
                        -- The watchlist, which this used to discard entirely.
                        -- It is 30% of what a member tracks here and the most
                        -- direct statement of intent they can make: finishing
                        -- something says it held their attention, but adding it
                        -- says they chose it. Weighted above `completed` and
                        -- below `is_favorite` for that reason.
                        WHEN tracked.status = 'plan_to_watch' THEN 3
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
                  OR tracked.status IN ('completed', 'watching', 'plan_to_watch')
              )
        ),
        -- The only way a member can say no.
        --
        -- Everything above is a way of saying yes — favourited, rated,
        -- finished, started, added. Dismissing a recommendation is the one
        -- signal that a genre was wrong, and without it the profile could only
        -- ever grow.
        --
        -- Weighted -2, against +4 for a favourite. Deliberately quieter than
        -- approval: dismissing one film in a genre says less than favouriting
        -- one does. The magnitudes make that concrete rather than hopeful — a
        -- settled profile here carries Drama at 803, so one dismissal moves it
        -- by a quarter of a per cent and it would take 402 of them to reach
        -- zero. A member with two tracked titles feels a single no immediately,
        -- which is the right way round: responsive while there is little to go
        -- on, steady once there is a lot.
        dismissed_genres AS (
            SELECT
                NULLIF(btrim(genre.value ->> 'id'), '') AS genre_id,
                NULLIF(btrim(genre.value ->> 'name'), '') AS genre_name,
                -2::double precision AS weight
            FROM discovery_dismissals dismissal
            JOIN media seed ON seed.id = dismissal.media_id
            CROSS JOIN LATERAL jsonb_array_elements(
                CASE
                    WHEN jsonb_typeof(seed.genres) = 'array' THEN seed.genres
                    ELSE '[]'::jsonb
                END
            ) AS genre(value)
            WHERE dismissal.user_id = $1
        ),
        combined AS (
            SELECT * FROM weighted_genres
            UNION ALL
            SELECT * FROM dismissed_genres
        )
        SELECT
            genre_id,
            MIN(genre_name) AS genre_name,
            SUM(weight)::double precision AS weight
        FROM combined
        WHERE genre_id IS NOT NULL
          AND genre_name IS NOT NULL
        GROUP BY genre_id
        -- A genre dismissed into negative territory is not a preference, and
        -- feeding it forward would subtract from every candidate carrying it
        -- rather than simply not favouring it.
        HAVING SUM(weight) > 0
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
              -- Asked not to see it. Genre weight alone would not be enough:
              -- a dismissed title can still carry a member's strongest genres
              -- and come straight back to the top of the row.
              AND NOT EXISTS (
                  SELECT 1
                  FROM discovery_dismissals dismissal
                  WHERE dismissal.user_id = $3
                    AND dismissal.media_id = media.id
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
              -- Asked not to see it. Genre weight alone would not be enough:
              -- a dismissed title can still carry a member's strongest genres
              -- and come straight back to the top of the row.
              AND NOT EXISTS (
                  SELECT 1
                  FROM discovery_dismissals dismissal
                  WHERE dismissal.user_id = $3
                    AND dismissal.media_id = media.id
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
            -- Matched preference weight, divided by the square root of how
            -- many genres the candidate carries.
            --
            -- The plain sum rewarded breadth rather than fit. Candidates here
            -- carry between zero and seven genres and average 2.2, so a
            -- seven-genre title could accumulate seven weights while a focused
            -- one collected at most a single weight — and won on that alone.
            -- The square root keeps matching several of a member's genres worth
            -- more than matching one, without letting a title win by being
            -- about everything.
            (
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
                ), 0)
                / SQRT(GREATEST(
                    CASE
                        WHEN jsonb_typeof(candidate.genres) = 'array'
                            THEN jsonb_array_length(candidate.genres)
                        ELSE 0
                    END,
                    1
                ))
            )::double precision AS affinity
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

/// The popular rows, minus anything already in this member's library.
///
/// The exclusion is the point. Measured on production before it was added, four
/// of the twelve popular series and four of the twelve popular films were shows
/// the member was already watching — a third of a discovery surface spent
/// telling somebody about something they had already found. Every other row on
/// this page already drops what you track; this was the one that did not, so a
/// title disappeared from your recommendations the moment you added it and sat
/// on in Popular.
///
/// Filtered in SQL rather than afterwards so the row still comes back full: the
/// database skips them and keeps taking the next most popular title, where
/// trimming in Rust would leave eight cards where twelve were asked for.
async fn load_popular(
    pool: &PgPool,
    user_id: Uuid,
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
                  AND NOT EXISTS (
                      SELECT 1 FROM user_media tracked
                      WHERE tracked.user_id = $4
                        AND tracked.media_id = media.id
                  )
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
                  AND NOT EXISTS (
                      SELECT 1 FROM user_media tracked
                      WHERE tracked.user_id = $4
                        AND tracked.media_id = media.id
                  )
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
    .bind(user_id)
    .fetch_all(pool)
    .await
}

#[derive(FromRow)]
pub struct SeedRow {
    pub tmdb_id: i32,
    pub media_type: String,
    pub title: String,
}

/// Pick what a "because you watched" row is built from.
///
/// The score separates less than the shape suggests. With no ratings recorded
/// anywhere it collapses to favourite plus completed, which leaves 22 titles
/// tied at the top for a typical member here — so `updated_at` decides, and the
/// row is in practice "the favourite you touched most recently". That is a
/// reasonable answer and worth stating plainly rather than calling it the
/// strongest signal in the library.
///
/// Every write to `updated_at` comes from the member: marking an episode
/// watched, editing tracking, or the automatic completion that follows
/// finishing a series. No background job moves it, so recency here means
/// theirs.
///
/// The status clause is what stops the row lying. Favourite, rating and
/// `completed` are alternatives, so without it a favourited item still sitting
/// on the watchlist could seed a row that says "because you watched" something
/// nobody watched. No member has favourited a watchlist entry yet; nothing
/// prevented it either.
/// How many of the strongest candidates the daily seed is drawn from.
///
/// Twenty is wide enough that the row is not the same all season and narrow
/// enough that it still draws on things you actually liked.
const SEED_POOL_SIZE: i64 = 20;

/// The title the "because you watched" row is built from.
///
/// Three properties, and each one was a bug without the others.
///
/// **It moves.** Ranking alone picked one title and kept it: the score below
/// saturates — a favourite you have finished scores 5, and so does every other
/// one — so the `updated_at` tiebreak decided, and a member with 522 eligible
/// titles saw the same seed for months.
///
/// **It holds still within a day.** Re-drawing per request is the same bug from
/// the other side: React Query refetches, and the heading would change under the
/// reader mid-scroll.
///
/// **It follows what you are actually watching.** A plain rotation fixed the
/// first two and broke this one, giving a show last seen in 2017 the same
/// chance as one finished last week — the eligible pool for that member spanned
/// 2017 to 2026. So candidates are weighted by how recently they were watched
/// and how hard, and the draw is weighted rather than uniform.
///
/// The weight is `base × recency × intensity`:
///
/// * `base` is the existing signal — favourite, rating, finished.
/// * `recency` is `1 + 12/(1 + days/14)`: about 13 for something watched today,
///   5 at a month, 1.4 at a year, 1.05 at nine years. Old favourites still
///   surface; they just stop being the common answer.
/// * `intensity` is `1 + min(episodes in the last 60 days, 20)/10`, so a
///   binge counts for up to three times a passing watch. Scoped to the recent
///   window on purpose: an unscoped version ranked a 2017 marathon fourth,
///   above shows watched in 2025.
///
/// The draw itself is Efraimidis–Spirakis — order by `u^(1/weight)` for a
/// uniform `u` — with `u` taken from a hash of the member, the date and the
/// title. No stored state, no clock beyond the date, and two members with the
/// same library do not march in step.
/// The seed for a given day. Public so the rotation can be tested on real
/// dates rather than against a copy of this query, which would pass whatever
/// this did.
pub async fn recommendation_seed(
    pool: &PgPool,
    user_id: Uuid,
    on: NaiveDate,
) -> Result<Option<SeedRow>, sqlx::Error> {
    sqlx::query_as::<_, SeedRow>(
        r#"WITH activity AS (
            -- When each title was last watched, and how hard it was watched
            -- lately. `last_watched` falls back to the tracking row for films
            -- and for anything tracked without logging episodes.
            SELECT
                wh.media_id,
                max(wh.watched_at) AS last_watched,
                count(*) FILTER (WHERE wh.watched_at > NOW() - INTERVAL '60 days')
                    AS recent_episodes
            FROM watch_history wh
            WHERE wh.user_id = $1
            GROUP BY wh.media_id
        ),
        eligible AS (
            SELECT
                m.tmdb_id,
                m.media_type,
                m.title,
                (
                    CASE WHEN um.is_favorite THEN 4 ELSE 0 END
                    + CASE WHEN um.rating >= 8 THEN 2 WHEN um.rating >= 7 THEN 1 ELSE 0 END
                    + CASE WHEN um.status = 'completed' THEN 1 ELSE 0 END
                )::double precision
                * (
                    1 + 12.0 / (
                        1 + EXTRACT(
                            EPOCH FROM (NOW() - COALESCE(a.last_watched, um.updated_at))
                        ) / 86400 / 14
                    )
                )
                * (1 + LEAST(COALESCE(a.recent_episodes, 0), 20) / 10.0) AS weight
            FROM user_media um
            JOIN media m ON m.id = um.media_id
            LEFT JOIN activity a ON a.media_id = um.media_id
            WHERE um.user_id = $1
              AND m.tmdb_id > 0
              AND um.status IN ('completed', 'watching')
              AND (um.is_favorite OR um.rating >= 7 OR um.status = 'completed')
            ORDER BY weight DESC, um.updated_at DESC, m.tmdb_id
            LIMIT $2
        )
        SELECT tmdb_id, media_type, title
        FROM eligible
        -- Efraimidis-Spirakis: the largest u^(1/weight) wins, which draws in
        -- proportion to weight. `+ 0.5` keeps u strictly positive, since
        -- `0^(1/w)` is zero for every weight and would silently exclude
        -- whichever title happened to hash to zero.
        ORDER BY power(
            (
                ('x' || substr(md5($1::text || $3::date::text || tmdb_id::text), 1, 8))::bit(32)::bigint
                + 0.5
            ) / 4294967296.0,
            1.0 / weight
        ) DESC
        LIMIT 1"#,
    )
    .bind(user_id)
    .bind(SEED_POOL_SIZE)
    .bind(on)
    .fetch_optional(pool)
    .await
}

async fn load_seed(pool: &PgPool, user_id: Uuid) -> Result<Option<SeedRow>, sqlx::Error> {
    recommendation_seed(pool, user_id, Utc::now().date_naive()).await
}

/// The TMDB ids the viewer already tracks for a media type, used to drop
/// recommendations they have already seen.
async fn load_tracked_tmdb_ids(
    pool: &PgPool,
    user_id: Uuid,
    media_type: &str,
) -> Result<Vec<i32>, sqlx::Error> {
    sqlx::query_scalar::<_, i32>(
        r#"SELECT m.tmdb_id
        FROM user_media um
        JOIN media m ON m.id = um.media_id
        WHERE um.user_id = $1 AND m.media_type = $2 AND m.tmdb_id > 0"#,
    )
    .bind(user_id)
    .bind(media_type)
    .fetch_all(pool)
    .await
}

/// Drop the seed itself, posterless entries, and titles already in the library;
/// dedupe; backfill the media type (movie/tv recommendation results omit it);
/// cap at `limit`. Pure so it is unit-testable.
fn filter_recommendations(
    results: Vec<TmdbSearchResult>,
    seed_tmdb_id: i32,
    seed_media_type: &str,
    tracked: &HashSet<i32>,
    limit: usize,
) -> Vec<TmdbSearchResult> {
    let mut seen = HashSet::new();
    results
        .into_iter()
        .filter(|result| result.poster_path.is_some())
        .filter(|result| result.id != seed_tmdb_id)
        .filter(|result| !tracked.contains(&result.id))
        .filter(|result| seen.insert(result.id))
        .map(|mut result| {
            if result.media_type.is_none() {
                result.media_type = Some(seed_media_type.to_string());
            }
            result
        })
        .take(limit)
        .collect()
}

/// Best-effort "because you watched" row. Any failure (no seed, TMDB down, a
/// DB hiccup) resolves to `None` rather than failing the whole discovery load.
async fn load_because_you_watched(
    pool: &PgPool,
    tmdb: &TmdbService,
    user_id: Uuid,
    language_code: Option<&str>,
) -> Option<BecauseYouWatched> {
    let seed = match load_seed(pool, user_id).await {
        Ok(Some(seed)) => seed,
        Ok(None) => return None,
        Err(error) => {
            log::warn!("because-you-watched seed lookup failed: {error}");
            return None;
        }
    };
    let response = match tmdb
        .get_recommendations_cached(pool, seed.tmdb_id, &seed.media_type, language_code)
        .await
    {
        Ok(response) => response,
        Err(error) => {
            log::warn!("because-you-watched recommendations unavailable: {error}");
            return None;
        }
    };
    let tracked = match load_tracked_tmdb_ids(pool, user_id, &seed.media_type).await {
        Ok(ids) => ids.into_iter().collect::<HashSet<_>>(),
        Err(error) => {
            log::warn!("because-you-watched tracked lookup failed: {error}");
            return None;
        }
    };
    let results = filter_recommendations(
        response.results,
        seed.tmdb_id,
        &seed.media_type,
        &tracked,
        BECAUSE_YOU_WATCHED_SIZE,
    );
    if results.is_empty() {
        return None;
    }
    Some(BecauseYouWatched {
        seed_tmdb_id: seed.tmdb_id,
        seed_media_type: seed.media_type,
        seed_title: seed.title,
        results,
    })
}

/// Record that a member does not want to see a title again.
///
/// Idempotent: dismissing twice is the same as dismissing once, which matters
/// because the interface fires this from a card that may still be on screen
/// when the list refreshes.
///
/// Takes the catalogue id rather than a TMDB id so a dismissal cannot outlive
/// the row it refers to — the foreign key removes it when the title goes.
pub async fn dismiss_recommendation(
    pool: &PgPool,
    user_id: Uuid,
    tmdb_id: i32,
    media_type: &str,
) -> Result<(), AppError> {
    let affected = sqlx::query(
        r#"INSERT INTO discovery_dismissals (user_id, media_id)
        SELECT $1, media.id
        FROM media
        WHERE media.tmdb_id = $2 AND media.media_type = $3
        ON CONFLICT (user_id, media_id) DO NOTHING"#,
    )
    .bind(user_id)
    .bind(tmdb_id)
    .bind(media_type)
    .execute(pool)
    .await?;

    // Nothing inserted and nothing conflicting means the title is not in the
    // catalogue. Answering 404 rather than 204 keeps a typo from looking like
    // it worked.
    if affected.rows_affected() == 0 {
        let known = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS (SELECT 1 FROM media WHERE tmdb_id = $1 AND media_type = $2)",
        )
        .bind(tmdb_id)
        .bind(media_type)
        .fetch_one(pool)
        .await?;
        if !known {
            return Err(AppError::NotFound("Title not found".to_string()));
        }
    }

    Ok(())
}

pub async fn load_discovery(
    pool: &PgPool,
    tmdb: &TmdbService,
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
    let popular_rows = load_popular(
        pool,
        user_id,
        language_code.as_deref(),
        region_code.as_deref(),
    )
    .await?;
    let because_you_watched =
        load_because_you_watched(pool, tmdb, user_id, language_code.as_deref()).await;

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
        because_you_watched,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn result(id: i32, poster: Option<&str>) -> TmdbSearchResult {
        TmdbSearchResult {
            id,
            title: Some(format!("Title {id}")),
            name: None,
            original_title: None,
            original_name: None,
            overview: None,
            poster_path: poster.map(str::to_string),
            backdrop_path: None,
            release_date: None,
            first_air_date: None,
            vote_average: None,
            media_type: None,
            genre_ids: None,
        }
    }

    #[test]
    fn filter_recommendations_drops_seed_tracked_and_posterless() {
        let tracked = HashSet::from([200]);
        let results = vec![
            result(100, Some("/seed.jpg")),    // the seed itself
            result(200, Some("/tracked.jpg")), // already in the library
            result(300, None),                 // no poster
            result(400, Some("/keep.jpg")),    // kept
            result(400, Some("/dupe.jpg")),    // duplicate id
        ];

        let filtered = filter_recommendations(results, 100, "movie", &tracked, 12);

        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].id, 400);
        // movie/tv recommendation results omit media_type; it is backfilled.
        assert_eq!(filtered[0].media_type.as_deref(), Some("movie"));
    }

    #[test]
    fn filter_recommendations_respects_the_limit() {
        let tracked = HashSet::new();
        let results = (1..=20).map(|id| result(id, Some("/p.jpg"))).collect();
        let filtered = filter_recommendations(results, 999, "tv", &tracked, 5);
        assert_eq!(filtered.len(), 5);
        assert!(filtered
            .iter()
            .all(|r| r.media_type.as_deref() == Some("tv")));
    }

    #[test]
    fn filter_recommendations_can_be_empty() {
        let tracked = HashSet::from([1, 2, 3]);
        let results = vec![result(1, Some("/a.jpg")), result(2, Some("/b.jpg"))];
        assert!(filter_recommendations(results, 999, "movie", &tracked, 12).is_empty());
    }
}
