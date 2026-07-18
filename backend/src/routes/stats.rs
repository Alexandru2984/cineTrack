use actix_web::{web, HttpRequest, HttpResponse};
use chrono::{Datelike, NaiveDate, Utc};
use sqlx::PgPool;

use crate::dto::stats::*;
use crate::errors::AppError;
use crate::middleware::auth::require_auth;

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::scope("/stats")
            .route("/me", web::get().to(my_stats))
            .route("/me/heatmap", web::get().to(my_heatmap))
            .route("/me/genres", web::get().to(my_genres))
            .route("/me/monthly", web::get().to(my_monthly))
            .route("/me/wrapped", web::get().to(my_wrapped)),
    );
}

fn parse_year(query: &std::collections::HashMap<String, String>) -> Result<i32, AppError> {
    let year = query
        .get("year")
        .and_then(|value| value.parse().ok())
        .unwrap_or_else(|| Utc::now().year());
    if !(1900..=2100).contains(&year) {
        return Err(AppError::BadRequest(
            "Year must be between 1900 and 2100".to_string(),
        ));
    }
    Ok(year)
}

async fn my_wrapped(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    query: web::Query<std::collections::HashMap<String, String>>,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    let year = parse_year(&query)?;

    // Headline totals over the year's watch events.
    let (
        total_watches,
        movies_watched,
        episodes_watched,
        distinct_titles,
        total_minutes,
        first,
        last,
    ) = sqlx::query_as::<
        _,
        (
            i64,
            i64,
            i64,
            i64,
            i64,
            Option<NaiveDate>,
            Option<NaiveDate>,
        ),
    >(
        r#"SELECT
                COUNT(*)::bigint,
                COUNT(*) FILTER (WHERE m.media_type = 'movie')::bigint,
                COUNT(*) FILTER (WHERE m.media_type = 'tv')::bigint,
                COUNT(DISTINCT wh.media_id)::bigint,
                COALESCE(SUM(CASE
                    WHEN wh.episode_id IS NOT NULL
                        THEN COALESCE(e.runtime_minutes, m.runtime_minutes, 0)
                    ELSE COALESCE(m.runtime_minutes, 0)
                END), 0)::bigint,
                MIN((wh.watched_at AT TIME ZONE 'UTC')::date),
                MAX((wh.watched_at AT TIME ZONE 'UTC')::date)
            FROM watch_history wh
            JOIN media m ON wh.media_id = m.id
            LEFT JOIN episodes e ON wh.episode_id = e.id
            WHERE wh.user_id = $1
              AND EXTRACT(YEAR FROM wh.watched_at AT TIME ZONE 'UTC')::int = $2"#,
    )
    .bind(user_id)
    .bind(year)
    .fetch_one(pool.get_ref())
    .await?;

    // Top genres, counted once per distinct title watched this year.
    let top_genres = sqlx::query_as::<_, (String, i64)>(
        r#"SELECT genre->>'name' AS genre_name, COUNT(*)::bigint
        FROM (
            SELECT DISTINCT wh.media_id
            FROM watch_history wh
            WHERE wh.user_id = $1
              AND EXTRACT(YEAR FROM wh.watched_at AT TIME ZONE 'UTC')::int = $2
        ) watched
        JOIN media m ON m.id = watched.media_id,
        jsonb_array_elements(
            CASE WHEN jsonb_typeof(m.genres) = 'array' THEN m.genres ELSE '[]'::jsonb END
        ) AS genre
        WHERE NULLIF(btrim(genre->>'name'), '') IS NOT NULL
        GROUP BY genre_name
        ORDER BY COUNT(*) DESC, genre_name
        LIMIT 5"#,
    )
    .bind(user_id)
    .bind(year)
    .fetch_all(pool.get_ref())
    .await?
    .into_iter()
    .map(|(genre, count)| GenreDistribution { genre, count })
    .collect::<Vec<_>>();

    // Most-watched titles by event count (a binged show ranks high).
    let top_shows = sqlx::query_as::<_, (i32, String, String, Option<String>, i64)>(
        r#"SELECT m.tmdb_id, m.media_type, m.title, m.poster_path, COUNT(*)::bigint
        FROM watch_history wh
        JOIN media m ON wh.media_id = m.id
        WHERE wh.user_id = $1
          AND EXTRACT(YEAR FROM wh.watched_at AT TIME ZONE 'UTC')::int = $2
        GROUP BY m.tmdb_id, m.media_type, m.title, m.poster_path
        ORDER BY COUNT(*) DESC, m.title
        LIMIT 5"#,
    )
    .bind(user_id)
    .bind(year)
    .fetch_all(pool.get_ref())
    .await?
    .into_iter()
    .map(
        |(tmdb_id, media_type, title, poster_path, count)| WrappedTitle {
            tmdb_id,
            media_type,
            title,
            poster_path,
            count,
        },
    )
    .collect::<Vec<_>>();

    // Per-month counts, back-filled to a full 12-month series.
    let month_rows = sqlx::query_as::<_, (i32, i64)>(
        r#"SELECT EXTRACT(MONTH FROM wh.watched_at AT TIME ZONE 'UTC')::int AS month, COUNT(*)::bigint
        FROM watch_history wh
        WHERE wh.user_id = $1
          AND EXTRACT(YEAR FROM wh.watched_at AT TIME ZONE 'UTC')::int = $2
        GROUP BY month"#,
    )
    .bind(user_id)
    .bind(year)
    .fetch_all(pool.get_ref())
    .await?;
    let monthly: Vec<WrappedMonth> = (1..=12)
        .map(|month| WrappedMonth {
            month,
            count: month_rows
                .iter()
                .find(|(m, _)| *m == month)
                .map_or(0, |(_, count)| *count),
        })
        .collect();

    // Longest daily streak within the year.
    let year_dates = sqlx::query_as::<_, (NaiveDate,)>(
        r#"SELECT DISTINCT (watched_at AT TIME ZONE 'UTC')::date AS watch_date
        FROM watch_history
        WHERE user_id = $1
          AND EXTRACT(YEAR FROM watched_at AT TIME ZONE 'UTC')::int = $2"#,
    )
    .bind(user_id)
    .bind(year)
    .fetch_all(pool.get_ref())
    .await?;
    let (_, longest_streak) = calculate_streaks(&year_dates);

    Ok(HttpResponse::Ok().json(WrappedStats {
        year,
        total_watches,
        movies_watched,
        episodes_watched,
        distinct_titles,
        total_hours: total_minutes as f64 / 60.0,
        longest_streak,
        first_watch: first.map(|date| date.to_string()),
        last_watch: last.map(|date| date.to_string()),
        top_genres,
        top_shows,
        monthly,
    }))
}

async fn my_stats(pool: web::Data<PgPool>, req: HttpRequest) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;

    let total_movies = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM user_media um JOIN media m ON um.media_id = m.id WHERE um.user_id = $1 AND m.media_type = 'movie' AND um.status = 'completed'"
    )
    .bind(user_id)
    .fetch_one(pool.get_ref())
    .await?;

    let total_shows = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM user_media um JOIN media m ON um.media_id = m.id WHERE um.user_id = $1 AND m.media_type = 'tv' AND um.status <> 'plan_to_watch'"
    )
    .bind(user_id)
    .fetch_one(pool.get_ref())
    .await?;

    // Explicit history rows are watch events and therefore preserve rewatches.
    // Completed shows can have only part of their episode catalogue cached, so
    // fill each show's missing regular episodes independently.
    let (total_episodes, total_minutes) = sqlx::query_as::<_, (i64, i64)>(
        r#"WITH completed_tv AS (
            SELECT
                um.media_id,
                COALESCE((
                    SELECT SUM(COALESCE(s.episode_count, 0))::bigint
                    FROM seasons s
                    WHERE s.media_id = um.media_id AND s.season_number > 0
                ), 0) AS expected_episodes,
                COALESCE(
                    m.runtime_minutes,
                    (
                        SELECT ROUND(AVG(e.runtime_minutes))::integer
                        FROM episodes e
                        JOIN seasons s ON e.season_id = s.id
                        WHERE s.media_id = um.media_id
                          AND s.season_number > 0
                          AND e.runtime_minutes IS NOT NULL
                    ),
                    0
                )::bigint AS episode_runtime
            FROM user_media um
            JOIN media m ON um.media_id = m.id
            WHERE um.user_id = $1
              AND m.media_type = 'tv'
              AND um.status = 'completed'
        ),
        completed_coverage AS (
            SELECT
                c.media_id,
                (
                    COUNT(DISTINCT wh.episode_id) FILTER (WHERE s.season_number > 0)
                    + COUNT(*) FILTER (WHERE wh.id IS NOT NULL AND wh.episode_id IS NULL)
                )::bigint AS covered_episodes
            FROM completed_tv c
            LEFT JOIN watch_history wh
                ON wh.user_id = $1 AND wh.media_id = c.media_id
            LEFT JOIN episodes e ON wh.episode_id = e.id
            LEFT JOIN seasons s ON e.season_id = s.id
            GROUP BY c.media_id
        ),
        missing_tv AS (
            SELECT
                COALESCE(SUM(GREATEST(c.expected_episodes - v.covered_episodes, 0)), 0)::bigint
                    AS episode_count,
                COALESCE(SUM(
                    GREATEST(c.expected_episodes - v.covered_episodes, 0)
                    * c.episode_runtime
                ), 0)::bigint AS runtime_minutes
            FROM completed_tv c
            JOIN completed_coverage v ON v.media_id = c.media_id
        ),
        history_totals AS (
            SELECT
                COUNT(*) FILTER (WHERE m.media_type = 'tv')::bigint AS tv_events,
                COALESCE(SUM(
                    CASE
                        WHEN wh.episode_id IS NOT NULL
                            THEN COALESCE(e.runtime_minutes, m.runtime_minutes, 0)
                        ELSE COALESCE(m.runtime_minutes, 0)
                    END
                ), 0)::bigint AS runtime_minutes
            FROM watch_history wh
            JOIN media m ON wh.media_id = m.id
            LEFT JOIN episodes e ON wh.episode_id = e.id
            WHERE wh.user_id = $1
        )
        SELECT
            h.tv_events + missing.episode_count,
            h.runtime_minutes + missing.runtime_minutes
        FROM history_totals h
        CROSS JOIN missing_tv missing"#,
    )
    .bind(user_id)
    .fetch_one(pool.get_ref())
    .await?;

    let total_hours = total_minutes as f64 / 60.0;

    // Calculate streak
    let streak_data = sqlx::query_as::<_, (NaiveDate,)>(
        r#"SELECT DISTINCT (watched_at AT TIME ZONE 'UTC')::date AS watch_date
        FROM watch_history WHERE user_id = $1
        ORDER BY watch_date DESC"#,
    )
    .bind(user_id)
    .fetch_all(pool.get_ref())
    .await?;

    let (current_streak, longest_streak) = calculate_streaks(&streak_data);

    Ok(HttpResponse::Ok().json(UserStats {
        total_movies,
        total_shows,
        total_episodes,
        total_hours,
        current_streak,
        longest_streak,
    }))
}

fn calculate_streaks(dates: &[(NaiveDate,)]) -> (i32, i32) {
    calculate_streaks_at(dates, Utc::now().date_naive())
}

fn calculate_streaks_at(dates: &[(NaiveDate,)], today: NaiveDate) -> (i32, i32) {
    let mut dates: Vec<NaiveDate> = dates.iter().map(|(date,)| *date).collect();
    dates.sort_unstable_by(|left, right| right.cmp(left));
    dates.dedup();

    if dates.is_empty() {
        return (0, 0);
    }

    let current_is_active = dates[0] == today || dates[0] == today - chrono::Duration::days(1);
    let mut current_streak = usize::from(current_is_active);
    if current_is_active {
        for pair in dates.windows(2) {
            if (pair[0] - pair[1]).num_days() != 1 {
                break;
            }
            current_streak += 1;
        }
    }

    let mut longest_streak = 1_usize;
    let mut run = 1_usize;
    for pair in dates.windows(2) {
        if (pair[0] - pair[1]).num_days() == 1 {
            run += 1;
            longest_streak = longest_streak.max(run);
        } else {
            run = 1;
        }
    }

    (
        i32::try_from(current_streak).unwrap_or(i32::MAX),
        i32::try_from(longest_streak).unwrap_or(i32::MAX),
    )
}

async fn my_heatmap(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    query: web::Query<std::collections::HashMap<String, String>>,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    let year: i32 = query
        .get("year")
        .and_then(|y| y.parse().ok())
        .unwrap_or_else(|| Utc::now().year());

    if !(1900..=2100).contains(&year) {
        return Err(AppError::BadRequest(
            "Year must be between 1900 and 2100".to_string(),
        ));
    }

    let start_date = NaiveDate::from_ymd_opt(year, 1, 1)
        .ok_or_else(|| AppError::BadRequest("Invalid year".to_string()))?;
    let end_date = NaiveDate::from_ymd_opt(year, 12, 31)
        .ok_or_else(|| AppError::BadRequest("Invalid year".to_string()))?;

    let data = sqlx::query_as::<_, (NaiveDate, i64)>(
        r#"SELECT
            (watched_at AT TIME ZONE 'UTC')::date AS watch_date,
            COUNT(*)::bigint AS count
        FROM watch_history
        WHERE user_id = $1
          AND watched_at >= ($2::date::timestamp AT TIME ZONE 'UTC')
          AND watched_at < (($3::date + 1)::timestamp AT TIME ZONE 'UTC')
        GROUP BY watch_date
        ORDER BY watch_date"#,
    )
    .bind(user_id)
    .bind(start_date)
    .bind(end_date)
    .fetch_all(pool.get_ref())
    .await?;

    let response: Vec<HeatmapDay> = data
        .into_iter()
        .map(|(date, count)| HeatmapDay {
            date: date.to_string(),
            count,
        })
        .collect();

    Ok(HttpResponse::Ok().json(response))
}

async fn my_genres(pool: web::Data<PgPool>, req: HttpRequest) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;

    let data = sqlx::query_as::<_, (String, i64)>(
        r#"SELECT genre->>'name' as genre_name, COUNT(*) as count
        FROM user_media um
        JOIN media m ON um.media_id = m.id,
        jsonb_array_elements(
            CASE WHEN jsonb_typeof(m.genres) = 'array' THEN m.genres ELSE '[]'::jsonb END
        ) as genre
        WHERE um.user_id = $1
          AND um.status <> 'plan_to_watch'
          AND NULLIF(btrim(genre->>'name'), '') IS NOT NULL
        GROUP BY genre_name
        ORDER BY count DESC
        LIMIT 50"#,
    )
    .bind(user_id)
    .fetch_all(pool.get_ref())
    .await?;

    let response: Vec<GenreDistribution> = data
        .into_iter()
        .map(|(genre, count)| GenreDistribution { genre, count })
        .collect();

    Ok(HttpResponse::Ok().json(response))
}

async fn my_monthly(pool: web::Data<PgPool>, req: HttpRequest) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;

    let data = sqlx::query_as::<_, (String, Option<i64>, i64)>(
        r#"SELECT
            TO_CHAR(wh.watched_at AT TIME ZONE 'UTC', 'YYYY-MM') as month,
            SUM(CASE
                WHEN wh.episode_id IS NOT NULL
                    THEN COALESCE(e.runtime_minutes, m.runtime_minutes, 0)
                ELSE COALESCE(m.runtime_minutes, 0)
            END)::bigint as total_minutes,
            COUNT(*) as count
        FROM watch_history wh
        JOIN media m ON wh.media_id = m.id
        LEFT JOIN episodes e ON wh.episode_id = e.id
        WHERE wh.user_id = $1
        GROUP BY month
        ORDER BY month DESC
        LIMIT 12"#,
    )
    .bind(user_id)
    .fetch_all(pool.get_ref())
    .await?;

    let response: Vec<MonthlyActivity> = data
        .into_iter()
        .map(|(month, minutes, count)| MonthlyActivity {
            month,
            hours: minutes.unwrap_or(0) as f64 / 60.0,
            count,
        })
        .collect();

    Ok(HttpResponse::Ok().json(response))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn date(value: &str) -> (NaiveDate,) {
        (NaiveDate::parse_from_str(value, "%Y-%m-%d").unwrap(),)
    }

    #[test]
    fn recent_streak_is_not_overwritten_by_an_older_longer_streak() {
        let today = NaiveDate::from_ymd_opt(2026, 7, 11).unwrap();
        let dates = vec![
            date("2026-07-11"),
            date("2026-07-10"),
            date("2026-07-07"),
            date("2026-07-06"),
            date("2026-07-05"),
            date("2026-07-04"),
        ];

        assert_eq!(calculate_streaks_at(&dates, today), (2, 4));
    }

    #[test]
    fn stale_activity_has_no_current_streak() {
        let today = NaiveDate::from_ymd_opt(2026, 7, 11).unwrap();
        let dates = vec![date("2026-07-08"), date("2026-07-07"), date("2026-07-06")];

        assert_eq!(calculate_streaks_at(&dates, today), (0, 3));
    }

    #[test]
    fn streak_calculation_sorts_and_deduplicates_dates() {
        let today = NaiveDate::from_ymd_opt(2026, 7, 11).unwrap();
        let dates = vec![
            date("2026-07-10"),
            date("2026-07-11"),
            date("2026-07-10"),
            date("2026-07-09"),
        ];

        assert_eq!(calculate_streaks_at(&dates, today), (3, 3));
    }
}
