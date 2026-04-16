use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Media {
    pub id: Uuid,
    pub tmdb_id: i32,
    pub media_type: String,
    pub title: String,
    pub original_title: Option<String>,
    pub overview: Option<String>,
    pub poster_path: Option<String>,
    pub backdrop_path: Option<String>,
    pub release_date: Option<NaiveDate>,
    pub status: Option<String>,
    pub genres: Option<serde_json::Value>,
    pub runtime_minutes: Option<i32>,
    pub tmdb_vote_average: Option<f64>,
    pub tmdb_cached_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Season {
    pub id: Uuid,
    pub media_id: Uuid,
    pub season_number: i32,
    pub name: Option<String>,
    pub episode_count: Option<i32>,
    pub air_date: Option<NaiveDate>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Episode {
    pub id: Uuid,
    pub season_id: Uuid,
    pub episode_number: i32,
    pub name: Option<String>,
    pub overview: Option<String>,
    pub runtime_minutes: Option<i32>,
    pub air_date: Option<NaiveDate>,
    pub still_path: Option<String>,
}
