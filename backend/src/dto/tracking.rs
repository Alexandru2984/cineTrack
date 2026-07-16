use serde::{Deserialize, Serialize};
use uuid::Uuid;
use validator::Validate;

pub const VALID_MEDIA_TYPES: &[&str] = &["movie", "tv"];
pub const VALID_TRACKING_STATUSES: &[&str] = &[
    "watching",
    "completed",
    "plan_to_watch",
    "dropped",
    "on_hold",
];

#[derive(Debug, Serialize)]
pub struct SeasonWatchProgress {
    pub season_number: i32,
    pub episode_count: Option<i32>,
    pub available_episode_count: i64,
    pub watched_count: i64,
}

#[derive(Debug, Serialize)]
pub struct BulkWatchResponse {
    pub media_id: Uuid,
    pub candidate_count: i64,
    pub marked_count: i64,
    pub already_watched_count: i64,
}

fn validate_media_type(media_type: &str) -> Result<(), validator::ValidationError> {
    if VALID_MEDIA_TYPES.contains(&media_type) {
        Ok(())
    } else {
        let mut err = validator::ValidationError::new("invalid_media_type");
        err.message = Some("Media type must be movie or tv".into());
        Err(err)
    }
}

fn validate_tracking_status(status: &str) -> Result<(), validator::ValidationError> {
    if VALID_TRACKING_STATUSES.contains(&status) {
        Ok(())
    } else {
        let mut err = validator::ValidationError::new("invalid_status");
        err.message = Some("Invalid tracking status".into());
        Err(err)
    }
}

#[derive(Debug, Deserialize, Validate)]
#[serde(deny_unknown_fields)]
pub struct CreateTrackingRequest {
    #[validate(range(min = 1, message = "TMDB id must be positive"))]
    pub tmdb_id: i32,
    #[validate(custom(function = "validate_media_type"))]
    pub media_type: String,
    #[validate(custom(function = "validate_tracking_status"))]
    pub status: String,
}

#[derive(Debug, Deserialize, Validate)]
#[serde(deny_unknown_fields)]
pub struct UpdateTrackingRequest {
    #[validate(custom(function = "validate_tracking_status"))]
    pub status: Option<String>,
    #[validate(range(min = 1, max = 10, message = "Rating must be between 1 and 10"))]
    pub rating: Option<i16>,
    #[validate(length(max = 5000, message = "Review must be at most 5000 characters"))]
    pub review: Option<String>,
    pub is_favorite: Option<bool>,
    pub started_at: Option<chrono::NaiveDate>,
    pub completed_at: Option<chrono::NaiveDate>,
}

#[derive(Debug, Deserialize, Validate)]
pub struct TrackingQueryParams {
    #[validate(custom(function = "validate_tracking_status"))]
    pub status: Option<String>,
    #[validate(range(min = 1, max = 1000, message = "Page must be between 1 and 1000"))]
    pub page: Option<u32>,
    #[validate(range(min = 1, max = 100, message = "Limit must be between 1 and 100"))]
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
#[serde(deny_unknown_fields)]
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
            status: None,
            rating: None,
            review: None,
            is_favorite: None,
            started_at: None,
            completed_at: None,
        };
        assert!(req.validate().is_ok());
    }

    #[test]
    fn tracking_pagination_is_bounded() {
        let valid = TrackingQueryParams {
            status: None,
            page: Some(1000),
            limit: Some(100),
        };
        assert!(valid.validate().is_ok());

        for invalid in [
            TrackingQueryParams {
                status: None,
                page: Some(0),
                limit: Some(50),
            },
            TrackingQueryParams {
                status: None,
                page: Some(1001),
                limit: Some(50),
            },
            TrackingQueryParams {
                status: None,
                page: Some(1),
                limit: Some(0),
            },
            TrackingQueryParams {
                status: None,
                page: Some(1),
                limit: Some(101),
            },
        ] {
            assert!(invalid.validate().is_err());
        }
    }

    #[test]
    fn test_update_tracking_review_too_long() {
        let req = UpdateTrackingRequest {
            status: None,
            rating: None,
            review: Some("x".repeat(5001)),
            is_favorite: None,
            started_at: None,
            completed_at: None,
        };
        assert!(req.validate().is_err());
    }

    #[test]
    fn test_update_tracking_review_boundary_5000() {
        let req = UpdateTrackingRequest {
            status: None,
            rating: None,
            review: Some("x".repeat(5000)),
            is_favorite: None,
            started_at: None,
            completed_at: None,
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

    #[test]
    fn test_create_tracking_rejects_bad_media_type() {
        let req = CreateTrackingRequest {
            tmdb_id: 1,
            media_type: "person".to_string(),
            status: "watching".to_string(),
        };
        assert!(req.validate().is_err());
    }

    #[test]
    fn test_create_tracking_rejects_non_positive_tmdb_id() {
        let req = CreateTrackingRequest {
            tmdb_id: 0,
            media_type: "movie".to_string(),
            status: "watching".to_string(),
        };
        assert!(req.validate().is_err());
    }

    #[test]
    fn test_update_tracking_rejects_bad_status() {
        let req = UpdateTrackingRequest {
            status: Some("rewatching".to_string()),
            rating: None,
            review: None,
            is_favorite: None,
            started_at: None,
            completed_at: None,
        };
        assert!(req.validate().is_err());
    }

    #[test]
    fn tracking_payloads_reject_unknown_fields() {
        assert!(
            serde_json::from_value::<CreateTrackingRequest>(serde_json::json!({
                "tmdb_id": 1,
                "media_type": "movie",
                "status": "watching",
                "user_id": Uuid::new_v4()
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<UpdateTrackingRequest>(serde_json::json!({
                "status": "completed",
                "watched": true
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<CreateHistoryRequest>(serde_json::json!({
                "media_id": Uuid::new_v4(),
                "episode_id": null,
                "watched_at": null,
                "user_id": Uuid::new_v4()
            }))
            .is_err()
        );
    }
}
