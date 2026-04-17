use serde::{Deserialize, Serialize};
use uuid::Uuid;
use validator::Validate;

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
    pub created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Serialize)]
pub struct ActivityItem {
    pub id: Uuid,
    pub user_id: Uuid,
    pub username: String,
    pub avatar_url: Option<String>,
    pub action: String,
    pub media_title: String,
    pub media_type: String,
    pub poster_path: Option<String>,
    pub timestamp: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Deserialize, Validate)]
pub struct CreateListRequest {
    #[validate(length(min = 1, max = 200, message = "List name must be 1-200 characters"))]
    pub name: String,
    #[validate(length(max = 1000, message = "Description must be at most 1000 characters"))]
    pub description: Option<String>,
    pub is_public: Option<bool>,
}

#[derive(Debug, Deserialize, Validate)]
pub struct UpdateListRequest {
    #[validate(length(min = 1, max = 200, message = "List name must be 1-200 characters"))]
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
            name: None, description: None, is_public: None,
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
}
