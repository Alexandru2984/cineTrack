use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Serialize)]
pub struct PublicUserProfile {
    pub id: Uuid,
    pub username: String,
    pub avatar_url: Option<String>,
    pub bio: Option<String>,
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

#[derive(Debug, Deserialize)]
pub struct CreateListRequest {
    pub name: String,
    pub description: Option<String>,
    pub is_public: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateListRequest {
    pub name: Option<String>,
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
