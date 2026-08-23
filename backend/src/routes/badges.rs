use actix_web::{web, HttpRequest, HttpResponse};
use sqlx::PgPool;
use std::collections::HashMap;
use uuid::Uuid;

use crate::dto::badge::{BadgeProgress, BadgeShelf, BadgeShow, EarnedBadge};
use crate::errors::AppError;
use crate::middleware::auth::require_auth;
use crate::services::badges::{self, BADGES};

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(web::scope("/badges").route("", web::get().to(my_badges)));
}

/// How many shows to name per badge.
///
/// Enough to say what a tier was earned for, few enough that the response does
/// not become the two-hundred-entry list this design exists to avoid. The full
/// set is a question the profile can ask separately if it ever needs to.
const SHOWS_PER_BADGE: usize = 4;

async fn my_badges(pool: web::Data<PgPool>, req: HttpRequest) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;

    let rows = sqlx::query_as::<
        _,
        (
            String,
            Option<Uuid>,
            Option<i32>,
            Option<String>,
            Option<String>,
            chrono::DateTime<chrono::Utc>,
        ),
    >(
        r#"SELECT badges.badge_key, badges.media_id, media.tmdb_id, media.title,
                  media.poster_path, badges.earned_at
        FROM user_badges badges
        LEFT JOIN media ON media.id = badges.media_id
        WHERE badges.user_id = $1
        ORDER BY badges.earned_at DESC"#,
    )
    .bind(user_id)
    .fetch_all(pool.get_ref())
    .await?;

    let mut grouped: HashMap<String, EarnedBadge> = HashMap::new();
    for (badge_key, media_id, tmdb_id, title, poster_path, earned_at) in rows {
        let Some(definition) = BADGES.iter().find(|badge| badge.key == badge_key) else {
            // A badge key the running code no longer defines. Skipped rather
            // than guessed at: a row from a tier that was renamed or withdrawn
            // has no honest label to give it.
            continue;
        };

        let entry = grouped
            .entry(badge_key.clone())
            .or_insert_with(|| EarnedBadge {
                key: badge_key.clone(),
                family: definition.family.to_string(),
                threshold: definition.threshold,
                count: 0,
                first_earned_at: earned_at,
                shows: Vec::new(),
            });
        entry.count += 1;
        // Rows arrive newest first, so the oldest is the last one seen.
        entry.first_earned_at = earned_at;
        if let (Some(media_id), Some(tmdb_id), Some(title)) = (media_id, tmdb_id, title) {
            if entry.shows.len() < SHOWS_PER_BADGE {
                entry.shows.push(BadgeShow {
                    media_id,
                    tmdb_id,
                    title,
                    poster_path,
                    earned_at,
                });
            }
        }
    }

    let mut earned: Vec<EarnedBadge> = grouped.into_values().collect();
    earned.sort_by_key(|badge| std::cmp::Reverse(badge.first_earned_at));

    // Progress towards the next unearned tier in each family. Families where
    // every tier is earned are left out: a bar that cannot move is noise.
    let standings = badges::family_standings(pool.get_ref(), user_id).await?;
    let mut progress = Vec::new();
    for (family, current) in standings {
        let next = BADGES
            .iter()
            .filter(|badge| badge.family == family && badge.threshold > current)
            .min_by_key(|badge| badge.threshold);
        if let Some(badge) = next {
            progress.push(BadgeProgress {
                family,
                next_key: badge.key.to_string(),
                current,
                threshold: badge.threshold,
            });
        }
    }
    progress.sort_by_key(|item| item.threshold - item.current);

    Ok(HttpResponse::Ok()
        .insert_header(("Cache-Control", "no-store"))
        .json(BadgeShelf { earned, progress }))
}
