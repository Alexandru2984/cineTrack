use serde::{Deserialize, Serialize};
use uuid::Uuid;
use validator::Validate;

#[derive(Debug, Deserialize)]
pub struct CreateTrackingRequest {
    pub tmdb_id: i32,
    pub media_type: String,
    pub status: String,
}

#[derive(Debug, Deserialize, Validate)]
pub struct UpdateTrackingRequest {
    pub status: Option<String>,
    pub rating: Option<i16>,
    #[validate(length(max = 5000, message = "Review must be at most 5000 characters"))]
    pub review: Option<String>,
    pub is_favorite: Option<bool>,
    pub started_at: Option<chrono::NaiveDate>,
    pub completed_at: Option<chrono::NaiveDate>,
}

#[derive(Debug, Deserialize)]
pub struct TrackingQueryParams {
    pub status: Option<String>,
    pub page: Option<u32>,
    pub limit: Option<u32>,
}

#[derive(Debug, Serialize)]
pub struct TrackingResponse {
    pub id: Uuid,
    pub media_id: Uuid,
    pub tmdb_id: i32,
    pub media_type: String,
    pub title: String,
    pub poster_path: Option<String>,
    pub status: String,
    pub rating: Option<i16>,
    pub review: Option<String>,
    pub is_favorite: bool,
    pub started_at: Option<chrono::NaiveDate>,
    pub completed_at: Option<chrono::NaiveDate>,
}

#[derive(Debug, Deserialize)]
pub struct CreateHistoryRequest {
    pub media_id: Uuid,
    pub episode_id: Option<Uuid>,
    pub watched_at: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Debug, Serialize)]
pub struct HistoryResponse {
    pub id: Uuid,
    pub media_id: Uuid,
    pub media_title: String,
    pub media_type: String,
    pub poster_path: Option<String>,
    pub episode_id: Option<Uuid>,
    pub episode_name: Option<String>,
    pub watched_at: chrono::DateTime<chrono::Utc>,
}
