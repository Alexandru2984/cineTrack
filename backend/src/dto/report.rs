use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;
use validator::{Validate, ValidationError};

pub const REPORT_REASONS: &[&str] = &[
    "harassment",
    "hate",
    "threatening",
    "sexual",
    "child_safety",
    "impersonation",
    "spam",
    "privacy",
    "copyright",
    "other",
];

fn validate_target_type(value: &str) -> Result<(), ValidationError> {
    if matches!(value, "user" | "list") {
        return Ok(());
    }

    let mut error = ValidationError::new("invalid_target_type");
    error.message = Some("Report target must be user or list".into());
    Err(error)
}

fn validate_reason(value: &str) -> Result<(), ValidationError> {
    if REPORT_REASONS.contains(&value) {
        return Ok(());
    }

    let mut error = ValidationError::new("invalid_reason");
    error.message = Some("Invalid report reason".into());
    Err(error)
}

fn validate_optional_details(value: &str) -> Result<(), ValidationError> {
    if !value.trim().is_empty() {
        return Ok(());
    }

    let mut error = ValidationError::new("blank_details");
    error.message = Some("Report details cannot be blank".into());
    Err(error)
}

#[derive(Debug, Deserialize, Validate)]
#[serde(deny_unknown_fields)]
pub struct CreateReportRequest {
    #[validate(custom(function = "validate_target_type"))]
    pub target_type: String,
    pub target_id: Uuid,
    #[validate(custom(function = "validate_reason"))]
    pub reason: String,
    #[validate(
        length(max = 1000, message = "Report details must be at most 1000 characters"),
        custom(function = "validate_optional_details")
    )]
    pub details: Option<String>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct ReportResponse {
    pub id: Uuid,
    pub target_type: String,
    pub target_id: Uuid,
    pub reason: String,
    pub details: Option<String>,
    pub status: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct BlockedUserResponse {
    pub id: Uuid,
    pub username: String,
    pub avatar_url: Option<String>,
    pub blocked_at: chrono::DateTime<chrono::Utc>,
}

const REPORT_STATUSES: &[&str] = &["open", "reviewing", "actioned", "dismissed"];

fn validate_queue_status(value: &str) -> Result<(), ValidationError> {
    if matches!(
        value,
        "active" | "all" | "open" | "reviewing" | "actioned" | "dismissed"
    ) {
        return Ok(());
    }
    Err(ValidationError::new("invalid_report_status"))
}

fn validate_moderation_status(value: &str) -> Result<(), ValidationError> {
    if REPORT_STATUSES.contains(&value) {
        return Ok(());
    }
    Err(ValidationError::new("invalid_report_status"))
}

fn validate_moderator_note(value: &str) -> Result<(), ValidationError> {
    if value.trim().len() >= 3 {
        return Ok(());
    }
    let mut error = ValidationError::new("moderator_note_too_short");
    error.message = Some("Moderator note must contain at least 3 characters".into());
    Err(error)
}

#[derive(Debug, Deserialize, Validate)]
#[serde(deny_unknown_fields)]
pub struct ModerationQueueParams {
    #[validate(custom(function = "validate_queue_status"))]
    pub status: Option<String>,
    #[validate(range(min = 1, max = 10_000))]
    pub page: Option<i64>,
    #[validate(range(min = 1, max = 100))]
    pub limit: Option<i64>,
}

impl ModerationQueueParams {
    pub fn status_val(&self) -> &str {
        self.status.as_deref().unwrap_or("active")
    }

    pub fn page_val(&self) -> i64 {
        self.page.unwrap_or(1)
    }

    pub fn limit_val(&self) -> i64 {
        self.limit.unwrap_or(25)
    }

    pub fn offset(&self) -> i64 {
        (self.page_val() - 1) * self.limit_val()
    }
}

#[derive(Debug, Deserialize, Validate)]
#[serde(deny_unknown_fields)]
pub struct UpdateReportStatusRequest {
    #[validate(custom(function = "validate_moderation_status"))]
    pub status: String,
    #[validate(
        length(max = 2000, message = "Moderator note must be at most 2000 characters"),
        custom(function = "validate_moderator_note")
    )]
    pub note: String,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct ModerationReportResponse {
    pub id: Uuid,
    pub reporter_id: Option<Uuid>,
    pub reporter_username: Option<String>,
    pub subject_user_id: Option<Uuid>,
    pub subject_username: Option<String>,
    pub target_type: String,
    pub target_id: Uuid,
    pub reason: String,
    pub details: Option<String>,
    pub content_snapshot: Value,
    pub status: String,
    pub moderated_by: Option<Uuid>,
    pub moderator_username: Option<String>,
    pub moderator_note: Option<String>,
    pub resolved_at: Option<chrono::DateTime<chrono::Utc>>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct ModerationStatusCounts {
    pub open: i64,
    pub reviewing: i64,
    pub actioned: i64,
    pub dismissed: i64,
}

#[derive(Debug, Serialize)]
pub struct ModerationQueueResponse {
    pub items: Vec<ModerationReportResponse>,
    pub counts: ModerationStatusCounts,
    pub page: i64,
    pub has_more: bool,
}

#[derive(Debug, Serialize)]
pub struct ModeratorStatusResponse {
    pub is_moderator: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_request() -> CreateReportRequest {
        CreateReportRequest {
            target_type: "user".to_string(),
            target_id: Uuid::new_v4(),
            reason: "harassment".to_string(),
            details: Some("Repeated unwanted contact".to_string()),
        }
    }

    #[test]
    fn report_payload_accepts_known_values() {
        assert!(valid_request().validate().is_ok());
    }

    #[test]
    fn report_payload_rejects_unknown_values_and_blank_details() {
        let mut request = valid_request();
        request.target_type = "episode".to_string();
        assert!(request.validate().is_err());

        let mut request = valid_request();
        request.reason = "ban_them".to_string();
        assert!(request.validate().is_err());

        let mut request = valid_request();
        request.details = Some("  ".to_string());
        assert!(request.validate().is_err());
    }

    #[test]
    fn report_payload_rejects_unknown_fields() {
        assert!(
            serde_json::from_value::<CreateReportRequest>(serde_json::json!({
                "target_type": "user",
                "target_id": Uuid::new_v4(),
                "reason": "spam",
                "moderator": true
            }))
            .is_err()
        );
    }

    #[test]
    fn moderation_inputs_are_bounded_and_reject_unknown_fields() {
        let valid = UpdateReportStatusRequest {
            status: "reviewing".to_string(),
            note: "Reviewed the supplied evidence".to_string(),
        };
        assert!(valid.validate().is_ok());

        let invalid_status = UpdateReportStatusRequest {
            status: "banned".to_string(),
            note: "Attempted privilege expansion".to_string(),
        };
        assert!(invalid_status.validate().is_err());

        let blank_note = UpdateReportStatusRequest {
            status: "dismissed".to_string(),
            note: "  ".to_string(),
        };
        assert!(blank_note.validate().is_err());

        assert!(
            serde_json::from_value::<UpdateReportStatusRequest>(serde_json::json!({
                "status": "actioned",
                "note": "Handled",
                "delete_user": true
            }))
            .is_err()
        );
    }

    #[test]
    fn moderation_queue_parameters_are_strictly_bounded() {
        let valid = ModerationQueueParams {
            status: Some("active".to_string()),
            page: Some(1),
            limit: Some(100),
        };
        assert!(valid.validate().is_ok());

        let invalid = ModerationQueueParams {
            status: Some("secret".to_string()),
            page: Some(0),
            limit: Some(101),
        };
        assert!(invalid.validate().is_err());
    }
}
