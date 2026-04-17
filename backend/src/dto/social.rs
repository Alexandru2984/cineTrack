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
