use serde::{Deserialize, Deserializer, Serialize};
use uuid::Uuid;
use validator::{Validate, ValidationError, ValidationErrors};

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

fn deserialize_nullable_patch<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateTrackingRequest {
    pub status: Option<String>,
    #[serde(default, deserialize_with = "deserialize_nullable_patch")]
    pub rating: Option<Option<i16>>,
    #[serde(default, deserialize_with = "deserialize_nullable_patch")]
    pub review: Option<Option<String>>,
    pub is_favorite: Option<bool>,
    pub started_at: Option<chrono::NaiveDate>,
    pub completed_at: Option<chrono::NaiveDate>,
}

impl UpdateTrackingRequest {
    pub fn validate(&self) -> Result<(), ValidationErrors> {
        let mut errors = ValidationErrors::new();

        if let Some(status) = self.status.as_deref() {
            if let Err(error) = validate_tracking_status(status) {
                errors.add("status", error);
            }
        }
        if self
            .rating
            .is_some_and(|rating| rating.is_some_and(|value| !(1..=10).contains(&value)))
        {
            let mut error = ValidationError::new("range");
            error.message = Some("Rating must be between 1 and 10".into());
            errors.add("rating", error);
        }
        if self
            .review
            .as_ref()
            .and_then(|review| review.as_ref())
            .is_some_and(|review| review.chars().count() > 5000)
        {
            let mut error = ValidationError::new("length");
            error.message = Some("Review must be at most 5000 characters".into());
            errors.add("review", error);
        }

        if errors.errors().is_empty() {
            Ok(())
        } else {
            Err(errors)
        }
    }
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

#[derive(Debug, Deserialize, Serialize, Validate)]
#[serde(deny_unknown_fields)]
pub struct TrackingLookupItem {
    #[validate(range(min = 1, message = "TMDB id must be positive"))]
    pub tmdb_id: i32,
    #[validate(custom(function = "validate_media_type"))]
    pub media_type: String,
}

#[derive(Debug, Deserialize, Validate)]
#[serde(deny_unknown_fields)]
pub struct TrackingLookupRequest {
    #[validate(length(
        min = 1,
        max = 100,
        message = "Lookup must contain between 1 and 100 items"
    ))]
    pub items: Vec<TrackingLookupItem>,
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
    pub tmdb_id: i32,
    pub media_title: String,
    pub media_type: String,
    pub poster_path: Option<String>,
    pub episode_id: Option<Uuid>,
    pub episode_name: Option<String>,
    pub season_number: Option<i32>,
    pub episode_number: Option<i32>,
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
    fn tracking_lookup_is_bounded_and_validated() {
        assert!(TrackingLookupRequest { items: vec![] }.validate().is_err());
        assert!(TrackingLookupRequest {
            items: (1..=100)
                .map(|tmdb_id| TrackingLookupItem {
                    tmdb_id,
                    media_type: "movie".to_string(),
                })
                .collect(),
        }
        .validate()
        .is_ok());
        assert!(TrackingLookupRequest {
            items: (1..=101)
                .map(|tmdb_id| TrackingLookupItem {
                    tmdb_id,
                    media_type: "movie".to_string(),
                })
                .collect(),
        }
        .validate()
        .is_err());

        assert!(TrackingLookupItem {
            tmdb_id: 0,
            media_type: "person".to_string(),
        }
        .validate()
        .is_err());
    }

    #[test]
    fn test_update_tracking_review_too_long() {
        let req = UpdateTrackingRequest {
            status: None,
            rating: None,
            review: Some(Some("x".repeat(5001))),
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
            review: Some(Some("x".repeat(5000))),
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
            rating: Some(Some(8)),
            review: Some(Some("Great movie!".to_string())),
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
    fn update_tracking_distinguishes_omitted_null_and_present_feedback() {
        let omitted = serde_json::from_value::<UpdateTrackingRequest>(serde_json::json!({}))
            .expect("omitted feedback should deserialize");
        assert_eq!(omitted.rating, None);
        assert_eq!(omitted.review, None);

        let cleared = serde_json::from_value::<UpdateTrackingRequest>(serde_json::json!({
            "rating": null,
            "review": null
        }))
        .expect("nullable feedback should deserialize");
        assert_eq!(cleared.rating, Some(None));
        assert_eq!(cleared.review, Some(None));

        let present = serde_json::from_value::<UpdateTrackingRequest>(serde_json::json!({
            "rating": 10,
            "review": "Excellent"
        }))
        .expect("present feedback should deserialize");
        assert_eq!(present.rating, Some(Some(10)));
        assert_eq!(
            present.review.as_ref().and_then(|review| review.as_deref()),
            Some("Excellent")
        );
        assert!(present.validate().is_ok());
    }

    #[test]
    fn update_tracking_rejects_out_of_range_rating() {
        for rating in [0, 11] {
            let req = UpdateTrackingRequest {
                status: None,
                rating: Some(Some(rating)),
                review: None,
                is_favorite: None,
                started_at: None,
                completed_at: None,
            };
            assert!(req.validate().is_err());
        }
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
