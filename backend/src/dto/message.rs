use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use validator::{Validate, ValidationError};

pub const MAX_MESSAGE_CHARACTERS: usize = 2_000;

fn normalized_message_body(value: &str) -> String {
    value.trim().replace("\r\n", "\n").replace('\r', "\n")
}

fn validate_message_body(value: &str) -> Result<(), ValidationError> {
    let normalized = normalized_message_body(value);
    if normalized.is_empty() || normalized.chars().count() > MAX_MESSAGE_CHARACTERS {
        let mut error = ValidationError::new("invalid_message_length");
        error.message =
            Some(format!("Message must be 1-{MAX_MESSAGE_CHARACTERS} characters").into());
        return Err(error);
    }

    if normalized
        .chars()
        .any(|character| character.is_control() && !matches!(character, '\n' | '\t'))
    {
        let mut error = ValidationError::new("invalid_message_control_character");
        error.message = Some("Message contains unsupported control characters".into());
        return Err(error);
    }

    Ok(())
}

#[derive(Debug, Deserialize, Validate)]
#[serde(deny_unknown_fields)]
pub struct SendMessageRequest {
    #[validate(custom(function = "validate_message_body"))]
    pub body: String,
    pub client_nonce: Uuid,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MarkThreadReadRequest {
    pub through_id: Uuid,
}

impl SendMessageRequest {
    pub fn normalized_body(&self) -> String {
        normalized_message_body(&self.body)
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MessageHistoryParams {
    pub limit: Option<u32>,
    pub before: Option<DateTime<Utc>>,
    pub before_id: Option<Uuid>,
}

impl MessageHistoryParams {
    pub fn limit_val(&self) -> i64 {
        self.limit.unwrap_or(50).clamp(1, 100) as i64
    }

    pub fn cursor(&self) -> Result<Option<(DateTime<Utc>, Uuid)>, &'static str> {
        match (self.before, self.before_id) {
            (Some(timestamp), Some(id)) => Ok(Some((timestamp, id))),
            (None, None) => Ok(None),
            _ => Err("Both before and before_id are required for message pagination"),
        }
    }
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct DirectMessageResponse {
    pub id: Uuid,
    pub sender_id: Uuid,
    pub recipient_id: Uuid,
    pub body: String,
    pub read_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct ConversationResponse {
    pub user_id: Uuid,
    pub username: String,
    pub avatar_url: Option<String>,
    pub last_message_id: Uuid,
    pub last_message_sender_id: Uuid,
    pub last_message_body: String,
    pub last_message_at: DateTime<Utc>,
    pub last_message_read_at: Option<DateTime<Utc>>,
    pub unread_count: i64,
    pub can_message: bool,
}

#[derive(Debug, Serialize)]
pub struct MessagePeerResponse {
    pub id: Uuid,
    pub username: String,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct MessageThreadResponse {
    pub user: MessagePeerResponse,
    pub can_message: bool,
    pub messages: Vec<DirectMessageResponse>,
}

#[derive(Debug, Serialize)]
pub struct MessageSummaryResponse {
    pub unread_count: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_body_is_trimmed_and_normalizes_newlines() {
        let request = SendMessageRequest {
            body: "  hello\r\nworld  ".to_string(),
            client_nonce: Uuid::new_v4(),
        };
        assert!(request.validate().is_ok());
        assert_eq!(request.normalized_body(), "hello\nworld");
    }

    #[test]
    fn message_body_rejects_blank_oversized_and_control_characters() {
        for body in [
            "   ".to_string(),
            "x".repeat(MAX_MESSAGE_CHARACTERS + 1),
            "hello\0world".to_string(),
        ] {
            let request = SendMessageRequest {
                body,
                client_nonce: Uuid::new_v4(),
            };
            assert!(request.validate().is_err());
        }
    }

    #[test]
    fn message_cursor_requires_complete_pair_and_bounds_limit() {
        let timestamp = Utc::now();
        let id = Uuid::new_v4();
        assert!(MessageHistoryParams {
            limit: None,
            before: Some(timestamp),
            before_id: None,
        }
        .cursor()
        .is_err());
        assert_eq!(
            MessageHistoryParams {
                limit: Some(u32::MAX),
                before: Some(timestamp),
                before_id: Some(id),
            }
            .limit_val(),
            100
        );
    }
}
