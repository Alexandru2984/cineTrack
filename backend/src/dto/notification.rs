use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use validator::Validate;

use crate::errors::AppError;

#[derive(Debug, Deserialize, Validate)]
pub struct NotificationQuery {
    #[validate(range(min = 1, max = 50, message = "Limit must be between 1 and 50"))]
    pub limit: Option<u32>,
    pub before: Option<DateTime<Utc>>,
    pub before_id: Option<Uuid>,
}

impl NotificationQuery {
    pub fn limit_val(&self) -> i64 {
        self.limit.unwrap_or(20) as i64
    }

    pub fn cursor(&self) -> Result<Option<(DateTime<Utc>, Uuid)>, AppError> {
        match (self.before, self.before_id) {
            (Some(timestamp), Some(id)) => Ok(Some((timestamp, id))),
            (None, None) => Ok(None),
            _ => Err(AppError::BadRequest(
                "Both before and before_id are required for notification pagination".to_string(),
            )),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct NotificationItem {
    pub id: Uuid,
    pub kind: String,
    pub actor_id: Uuid,
    pub actor_username: String,
    pub actor_avatar_url: Option<String>,
    pub read_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct NotificationListResponse {
    pub items: Vec<NotificationItem>,
    pub unread_count: i64,
    pub has_more: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notification_query_requires_a_complete_cursor() {
        let query = NotificationQuery {
            limit: Some(10),
            before: Some(Utc::now()),
            before_id: None,
        };
        assert!(query.validate().is_ok());
        assert!(query.cursor().is_err());
    }

    #[test]
    fn notification_query_bounds_page_size() {
        let query = NotificationQuery {
            limit: Some(51),
            before: None,
            before_id: None,
        };
        assert!(query.validate().is_err());
    }
}
