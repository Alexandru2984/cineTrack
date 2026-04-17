use actix_web::{web, HttpRequest, HttpResponse};
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
    );
}

async fn my_stats(
    pool: web::Data<PgPool>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;

    let total_movies = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM user_media um JOIN media m ON um.media_id = m.id WHERE um.user_id = $1 AND m.media_type = 'movie' AND um.status = 'completed'"
    )
    .bind(user_id)
    .fetch_one(pool.get_ref())
    .await?;

    let total_shows = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM user_media um JOIN media m ON um.media_id = m.id WHERE um.user_id = $1 AND m.media_type = 'tv'"
    )
    .bind(user_id)
    .fetch_one(pool.get_ref())
    .await?;

    // Count episodes: individually watched + episode counts from completed shows (for shows without individual episode tracking)
    let watched_episodes = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM watch_history WHERE user_id = $1 AND episode_id IS NOT NULL"
    )
    .bind(user_id)
    .fetch_one(pool.get_ref())
    .await?;

    let completed_show_episodes = sqlx::query_scalar::<_, Option<i64>>(
        r#"SELECT SUM(COALESCE(s.episode_count, 0))
        FROM user_media um
        JOIN media m ON um.media_id = m.id
        JOIN seasons s ON s.media_id = m.id AND s.season_number > 0
        WHERE um.user_id = $1 AND m.media_type = 'tv' AND um.status = 'completed'"#
    )
    .bind(user_id)
    .fetch_one(pool.get_ref())
    .await?
    .unwrap_or(0);

    let total_episodes = std::cmp::max(watched_episodes, completed_show_episodes);

    // Total hours calculation
    let total_minutes: Option<i64> = sqlx::query_scalar(
        r#"SELECT SUM(COALESCE(
            CASE WHEN wh.episode_id IS NOT NULL THEN e.runtime_minutes ELSE m.runtime_minutes END,
            0
        ))::bigint
        FROM watch_history wh
        JOIN media m ON wh.media_id = m.id
        LEFT JOIN episodes e ON wh.episode_id = e.id
        WHERE wh.user_id = $1"#
    )
    .bind(user_id)
    .fetch_one(pool.get_ref())
    .await?;

    let total_hours = total_minutes.unwrap_or(0) as f64 / 60.0;

    // Calculate streak
    let streak_data = sqlx::query_as::<_, (chrono::NaiveDate,)>(
        r#"SELECT DISTINCT watched_at::date as watch_date
        FROM watch_history WHERE user_id = $1
        ORDER BY watch_date DESC"#
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

fn calculate_streaks(dates: &[(chrono::NaiveDate,)]) -> (i32, i32) {
    if dates.is_empty() {
        return (0, 0);
    }

    let today = chrono::Utc::now().date_naive();
    let mut current_streak = 0;
    let mut longest_streak = 0;
    let mut streak = 0;
    let mut prev_date: Option<chrono::NaiveDate> = None;

    for (date,) in dates {
        match prev_date {
            None => {
                streak = 1;
                if *date == today || *date == today - chrono::Duration::days(1) {
                    current_streak = 1;
                }
            }
            Some(prev) => {
                let diff = prev - *date;
                if diff.num_days() == 1 {
                    streak += 1;
                    if current_streak > 0 {
                        current_streak = streak;
                    }
                } else {
                    longest_streak = longest_streak.max(streak);
                    streak = 1;
                }
            }
        }
        prev_date = Some(*date);
    }

    longest_streak = longest_streak.max(streak);
    (current_streak, longest_streak)
}

async fn my_heatmap(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    query: web::Query<std::collections::HashMap<String, String>>,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    let year: i32 = query.get("year")
        .and_then(|y| y.parse().ok())
        .unwrap_or_else(|| chrono::Utc::now().year());

    use chrono::Datelike;
    let start_date = chrono::NaiveDate::from_ymd_opt(year, 1, 1).unwrap();
    let end_date = chrono::NaiveDate::from_ymd_opt(year, 12, 31).unwrap();

    let data = sqlx::query_as::<_, (chrono::NaiveDate, i64)>(
        r#"SELECT watch_date, SUM(cnt)::bigint as count FROM (
            SELECT watched_at::date as watch_date, COUNT(*) as cnt
            FROM watch_history
            WHERE user_id = $1 AND watched_at::date BETWEEN $2 AND $3
            GROUP BY watch_date
            UNION ALL
            SELECT updated_at::date as watch_date, COUNT(*) as cnt
            FROM user_media
            WHERE user_id = $1 AND updated_at::date BETWEEN $2 AND $3
            GROUP BY watch_date
        ) combined
        GROUP BY watch_date
        ORDER BY watch_date"#
    )
    .bind(user_id)
    .bind(start_date)
    .bind(end_date)
    .fetch_all(pool.get_ref())
    .await?;

    let response: Vec<HeatmapDay> = data.into_iter().map(|(date, count)| {
        HeatmapDay {
            date: date.to_string(),
            count,
        }
    }).collect();

    Ok(HttpResponse::Ok().json(response))
}

async fn my_genres(
    pool: web::Data<PgPool>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;

    let data = sqlx::query_as::<_, (String, i64)>(
        r#"SELECT genre->>'name' as genre_name, COUNT(*) as count
        FROM user_media um
        JOIN media m ON um.media_id = m.id,
        jsonb_array_elements(m.genres) as genre
        WHERE um.user_id = $1 AND m.genres IS NOT NULL
        GROUP BY genre_name
        ORDER BY count DESC
        LIMIT 50"#
    )
    .bind(user_id)
    .fetch_all(pool.get_ref())
    .await?;

    let response: Vec<GenreDistribution> = data.into_iter().map(|(genre, count)| {
        GenreDistribution { genre, count }
    }).collect();

    Ok(HttpResponse::Ok().json(response))
}

async fn my_monthly(
    pool: web::Data<PgPool>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;

    let data = sqlx::query_as::<_, (String, Option<i64>, i64)>(
        r#"SELECT
            TO_CHAR(wh.watched_at, 'YYYY-MM') as month,
            SUM(COALESCE(
                CASE WHEN wh.episode_id IS NOT NULL THEN e.runtime_minutes ELSE m.runtime_minutes END,
                0
            ))::bigint as total_minutes,
            COUNT(*) as count
        FROM watch_history wh
        JOIN media m ON wh.media_id = m.id
        LEFT JOIN episodes e ON wh.episode_id = e.id
        WHERE wh.user_id = $1
        GROUP BY month
        ORDER BY month DESC
        LIMIT 12"#
    )
    .bind(user_id)
    .fetch_all(pool.get_ref())
    .await?;

    let response: Vec<MonthlyActivity> = data.into_iter().map(|(month, minutes, count)| {
        MonthlyActivity {
            month,
            hours: minutes.unwrap_or(0) as f64 / 60.0,
            count,
        }
    }).collect();

    Ok(HttpResponse::Ok().json(response))
}

use chrono::Datelike;
