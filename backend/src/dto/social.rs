use serde::{Deserialize, Serialize};
use uuid::Uuid;
use validator::Validate;

fn validate_non_blank(value: &str) -> Result<(), validator::ValidationError> {
    if value.trim().is_empty() {
        let mut err = validator::ValidationError::new("blank_value");
        err.message = Some("Value cannot be blank".into());
        return Err(err);
    }
    Ok(())
}

fn validate_username_search_fragment(value: &str) -> Result<(), validator::ValidationError> {
    let value = value.trim();
    if (2..=50).contains(&value.len())
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
    {
        return Ok(());
    }

    let mut err = validator::ValidationError::new("invalid_username_search");
    err.message = Some("Search must be 2-50 username characters".into());
    Err(err)
}

#[derive(Debug, Serialize)]
pub struct PublicUserProfile {
    pub id: Uuid,
    pub username: String,
    pub avatar_url: Option<String>,
    pub bio: Option<String>,
    pub is_public: bool,
    pub followers_count: i64,
    pub following_count: i64,
    pub is_following: bool,
    pub follow_status: Option<String>,
    pub can_view_activity: bool,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Serialize)]
pub struct FollowRequestResponse {
    pub user_id: Uuid,
    pub username: String,
    pub avatar_url: Option<String>,
    pub requested_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Deserialize, Validate)]
pub struct UserSearchParams {
    #[validate(custom(function = "validate_username_search_fragment"))]
    pub q: String,
    #[validate(range(min = 1, max = 1000, message = "Page must be between 1 and 1000"))]
    pub page: Option<u32>,
    #[validate(range(min = 1, max = 50, message = "Limit must be between 1 and 50"))]
    pub limit: Option<u32>,
}

impl UserSearchParams {
    pub fn page_val(&self) -> u32 {
        self.page.unwrap_or(1)
    }

    pub fn limit_val(&self) -> i64 {
        self.limit.unwrap_or(20) as i64
    }

    pub fn offset(&self) -> i64 {
        (self.page_val() as i64 - 1) * self.limit_val()
    }
}

#[derive(Debug, Serialize)]
pub struct UserSearchResult {
    pub id: Uuid,
    pub username: String,
    pub avatar_url: Option<String>,
    pub bio: Option<String>,
    pub is_public: bool,
    pub followers_count: i64,
    pub follow_status: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct UserSearchResponse {
    pub results: Vec<UserSearchResult>,
    pub page: u32,
    pub has_more: bool,
}

#[derive(Debug, Serialize)]
pub struct ActivityItem {
    pub id: Uuid,
    pub user_id: Uuid,
    pub username: String,
    pub avatar_url: Option<String>,
    pub action: String,
    pub tmdb_id: i32,
    pub media_title: String,
    pub media_type: String,
    pub poster_path: Option<String>,
    pub episode_name: Option<String>,
    pub season_number: Option<i32>,
    pub episode_number: Option<i32>,
    pub timestamp: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Deserialize, Validate)]
#[serde(deny_unknown_fields)]
pub struct CreateListRequest {
    #[validate(
        length(min = 1, max = 200, message = "List name must be 1-200 characters"),
        custom(function = "validate_non_blank")
    )]
    pub name: String,
    #[validate(length(max = 1000, message = "Description must be at most 1000 characters"))]
    pub description: Option<String>,
    pub is_public: Option<bool>,
}

#[derive(Debug, Deserialize, Validate)]
#[serde(deny_unknown_fields)]
pub struct UpdateListRequest {
    #[validate(
        length(min = 1, max = 200, message = "List name must be 1-200 characters"),
        custom(function = "validate_non_blank")
    )]
    pub name: Option<String>,
    #[validate(length(max = 1000, message = "Description must be at most 1000 characters"))]
    pub description: Option<String>,
    pub is_public: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct ListResponse {
    pub id: Uuid,
    pub name: String,
    pub description: Option<String>,
    pub is_public: bool,
    pub item_count: i64,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AddListItemRequest {
    pub media_id: Uuid,
}

#[cfg(test)]
mod tests {
    use super::*;
    use validator::Validate;

    #[test]
    fn test_create_list_valid() {
        let req = CreateListRequest {
            name: "My Favorites".to_string(),
            description: Some("Best movies ever".to_string()),
            is_public: Some(true),
        };
        assert!(req.validate().is_ok());
    }

    #[test]
    fn test_create_list_empty_name_rejected() {
        let req = CreateListRequest {
            name: "".to_string(),
            description: None,
            is_public: None,
        };
        assert!(req.validate().is_err());
    }

    #[test]
    fn test_create_list_blank_name_rejected() {
        let req = CreateListRequest {
            name: "   ".to_string(),
            description: None,
            is_public: None,
        };
        assert!(req.validate().is_err());
    }

    #[test]
    fn test_create_list_name_too_long() {
        let req = CreateListRequest {
            name: "x".repeat(201),
            description: None,
            is_public: None,
        };
        assert!(req.validate().is_err());
    }

    #[test]
    fn test_create_list_name_boundary_200() {
        let req = CreateListRequest {
            name: "x".repeat(200),
            description: None,
            is_public: None,
        };
        assert!(req.validate().is_ok());
    }

    #[test]
    fn test_create_list_description_too_long() {
        let req = CreateListRequest {
            name: "Test".to_string(),
            description: Some("x".repeat(1001)),
            is_public: None,
        };
        assert!(req.validate().is_err());
    }

    #[test]
    fn test_create_list_description_boundary_1000() {
        let req = CreateListRequest {
            name: "Test".to_string(),
            description: Some("x".repeat(1000)),
            is_public: None,
        };
        assert!(req.validate().is_ok());
    }

    #[test]
    fn test_update_list_all_none_valid() {
        let req = UpdateListRequest {
            name: None,
            description: None,
            is_public: None,
        };
        assert!(req.validate().is_ok());
    }

    #[test]
    fn test_update_list_empty_name_rejected() {
        let req = UpdateListRequest {
            name: Some("".to_string()),
            description: None,
            is_public: None,
        };
        assert!(req.validate().is_err());
    }

    #[test]
    fn test_update_list_blank_name_rejected() {
        let req = UpdateListRequest {
            name: Some("   ".to_string()),
            description: None,
            is_public: None,
        };
        assert!(req.validate().is_err());
    }

    #[test]
    fn user_search_accepts_literal_username_fragments() {
        let params = UserSearchParams {
            q: "some_user-2".to_string(),
            page: Some(2),
            limit: Some(10),
        };
        assert!(params.validate().is_ok());
        assert_eq!(params.offset(), 10);
    }

    #[test]
    fn user_search_rejects_short_wildcard_and_unbounded_inputs() {
        for query in ["a", "%admin", "two words"] {
            let params = UserSearchParams {
                q: query.to_string(),
                page: None,
                limit: None,
            };
            assert!(params.validate().is_err(), "query should fail: {query}");
        }

        let params = UserSearchParams {
            q: "valid".to_string(),
            page: Some(1001),
            limit: Some(51),
        };
        assert!(params.validate().is_err());
    }

    #[test]
    fn list_payloads_reject_unknown_fields() {
        assert!(
            serde_json::from_value::<CreateListRequest>(serde_json::json!({
                "name": "Favorites",
                "description": null,
                "is_public": false,
                "user_id": Uuid::new_v4()
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<UpdateListRequest>(serde_json::json!({
                "name": "Favorites",
                "owner_id": Uuid::new_v4()
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<AddListItemRequest>(serde_json::json!({
                "media_id": Uuid::new_v4(),
                "position": 1
            }))
            .is_err()
        );
    }
}
