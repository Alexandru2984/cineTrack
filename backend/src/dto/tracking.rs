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

#[cfg(test)]
mod tests {
    use super::*;
    use validator::Validate;

    #[test]
    fn test_update_tracking_valid_all_none() {
        let req = UpdateTrackingRequest {
            status: None, rating: None, review: None,
            is_favorite: None, started_at: None, completed_at: None,
        };
        assert!(req.validate().is_ok());
    }

    #[test]
    fn test_update_tracking_review_too_long() {
        let req = UpdateTrackingRequest {
            status: None, rating: None,
            review: Some("x".repeat(5001)),
            is_favorite: None, started_at: None, completed_at: None,
        };
        assert!(req.validate().is_err());
    }

    #[test]
    fn test_update_tracking_review_boundary_5000() {
        let req = UpdateTrackingRequest {
            status: None, rating: None,
            review: Some("x".repeat(5000)),
            is_favorite: None, started_at: None, completed_at: None,
        };
        assert!(req.validate().is_ok());
    }

    #[test]
    fn test_update_tracking_with_valid_fields() {
        let req = UpdateTrackingRequest {
            status: Some("completed".to_string()),
            rating: Some(8),
            review: Some("Great movie!".to_string()),
            is_favorite: Some(true),
            started_at: None,
            completed_at: None,
        };
        assert!(req.validate().is_ok());
    }
}
