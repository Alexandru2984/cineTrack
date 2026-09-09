use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct UserMedia {
    pub id: Uuid,
    pub user_id: Uuid,
    pub media_id: Uuid,
    pub status: String,
    pub rating: Option<i16>,
    pub review: Option<String>,
    pub is_favorite: bool,
    pub started_at: Option<NaiveDate>,
    pub completed_at: Option<NaiveDate>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct WatchHistory {
    pub id: Uuid,
    pub user_id: Uuid,
    pub media_id: Uuid,
    pub episode_id: Option<Uuid>,
    pub watched_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}
