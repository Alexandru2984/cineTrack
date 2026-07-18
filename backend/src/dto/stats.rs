use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct UserStats {
    pub total_movies: i64,
    pub total_shows: i64,
    pub total_episodes: i64,
    pub total_hours: f64,
    pub current_streak: i32,
    pub longest_streak: i32,
}

#[derive(Debug, Serialize)]
pub struct HeatmapDay {
    pub date: String,
    pub count: i64,
}

#[derive(Debug, Serialize)]
pub struct GenreDistribution {
    pub genre: String,
    pub count: i64,
}

#[derive(Debug, Serialize)]
pub struct MonthlyActivity {
    pub month: String,
    pub hours: f64,
    pub count: i64,
}

#[derive(Debug, Serialize)]
pub struct WrappedTitle {
    pub tmdb_id: i32,
    pub media_type: String,
    pub title: String,
    pub poster_path: Option<String>,
    pub count: i64,
}

#[derive(Debug, Serialize)]
pub struct WrappedMonth {
    /// 1-12
    pub month: i32,
    pub count: i64,
}

/// A year-scoped "Wrapped" recap built from the user's watch history events.
#[derive(Debug, Serialize)]
pub struct WrappedStats {
    pub year: i32,
    pub total_watches: i64,
    pub movies_watched: i64,
    pub episodes_watched: i64,
    pub distinct_titles: i64,
    pub total_hours: f64,
    pub longest_streak: i32,
    pub first_watch: Option<String>,
    pub last_watch: Option<String>,
    pub top_genres: Vec<GenreDistribution>,
    pub top_shows: Vec<WrappedTitle>,
    pub monthly: Vec<WrappedMonth>,
}
