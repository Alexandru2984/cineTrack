use serde::Serialize;
use uuid::Uuid;

/// One badge a member has earned, with the shows it was earned for.
///
/// Aggregated on purpose. The service this replaces stored a row per show and
/// displayed all of them: two hundred and twenty-eight entries, which is a
/// list nobody reads and a shelf where nothing stands out. Here the tier is the
/// achievement and the shows are its evidence, available when somebody asks for
/// it and out of the way when they do not.
#[derive(Debug, Serialize)]
pub struct EarnedBadge {
    pub key: String,
    pub family: String,
    pub threshold: i64,
    /// How many shows earned this tier. Always 1 for account-wide badges.
    pub count: i64,
    /// The first time the history satisfied this badge.
    pub first_earned_at: chrono::DateTime<chrono::Utc>,
    /// A few titles, newest first, so the UI can say what it was earned for
    /// without a second request. Empty for account-wide badges.
    pub shows: Vec<BadgeShow>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct BadgeShow {
    pub media_id: Uuid,
    pub tmdb_id: i32,
    pub title: String,
    pub poster_path: Option<String>,
    pub earned_at: chrono::DateTime<chrono::Utc>,
}

/// Progress towards the next tier of a family the member has not finished.
///
/// Shown so the shelf says what to do next rather than only what is done.
/// Absent once every tier in a family is earned — a full progress bar that can
/// never move is worse than none.
#[derive(Debug, Serialize)]
pub struct BadgeProgress {
    pub family: String,
    pub next_key: String,
    pub current: i64,
    pub threshold: i64,
}

#[derive(Debug, Serialize)]
pub struct BadgeShelf {
    pub earned: Vec<EarnedBadge>,
    pub progress: Vec<BadgeProgress>,
}
