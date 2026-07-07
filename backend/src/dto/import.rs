use serde::{Deserialize, Serialize};

/// TV Time external ids attached to a show/movie/episode in the browser-extension export.
#[derive(Debug, Deserialize)]
pub struct TvTimeExternalId {
    pub tvdb: Option<i64>,
    pub imdb: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct TvTimeEpisode {
    pub number: i32,
    #[serde(default)]
    pub is_watched: bool,
    #[serde(default)]
    pub watched_at: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct TvTimeSeason {
    pub number: i32,
    #[serde(default)]
    pub episodes: Vec<TvTimeEpisode>,
}

#[derive(Debug, Deserialize)]
pub struct TvTimeShow {
    pub id: TvTimeExternalId,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub seasons: Vec<TvTimeSeason>,
    #[serde(default)]
    pub created_at: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct TvTimeMovie {
    pub id: TvTimeExternalId,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub is_watched: bool,
    #[serde(default)]
    pub watched_at: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
}

/// One parsed row of the optional TV Time `rewatched_episode.csv` (GDPR export).
#[derive(Debug)]
pub struct RewatchRow {
    pub show_name: String,
    pub season_number: i32,
    pub episode_number: i32,
    pub created_at: String,
}

/// Summary counts written to `import_jobs.totals` and shown in the UI.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct ImportTotals {
    pub shows: i64,
    pub movies: i64,
    pub episodes_linked: i64,
    pub episodes_date_only: i64,
    pub rewatches: i64,
    pub unresolved: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct ImportJobResponse {
    pub id: uuid::Uuid,
    pub status: String,
    pub totals: Option<serde_json::Value>,
    pub error: Option<String>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}
