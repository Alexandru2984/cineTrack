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
