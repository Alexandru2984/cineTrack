use serde::{Deserialize, Serialize};
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
}
