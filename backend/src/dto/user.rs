use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use validator::Validate;

use crate::dto::validation::validate_username;

#[derive(Debug, Deserialize, Validate)]
#[serde(deny_unknown_fields)]
pub struct UpdateProfileRequest {
    #[validate(length(min = 3, max = 50), custom(function = "validate_username"))]
    pub username: Option<String>,
    #[validate(length(max = 500, message = "Bio must be at most 500 characters"))]
    pub bio: Option<String>,
    pub is_public: Option<bool>,
}

/// Account deletion is irreversible, so we require the current password as a
/// confirmation step (also blocks CSRF-style state changes from a stolen cookie
/// alone, since the access token is required separately).
#[derive(Debug, Deserialize, Validate)]
#[serde(deny_unknown_fields)]
pub struct DeleteAccountRequest {
    #[validate(length(min = 1, max = 128, message = "Password must be 1-128 characters"))]
    pub password: String,
    #[validate(length(max = 64, message = "Two-factor code is too long"))]
    pub totp_code: Option<String>,
}

/// Exporting an account exposes private notes, watch history, and relationship
/// data, so a live session alone is insufficient confirmation.
#[derive(Debug, Deserialize, Validate)]
#[serde(deny_unknown_fields)]
pub struct DataExportRequest {
    #[validate(length(min = 1, max = 128, message = "Password must be 1-128 characters"))]
    pub password: String,
    #[validate(length(max = 64, message = "Two-factor code is too long"))]
    pub totp_code: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct AccountDataExport {
    pub format_version: u8,
    pub exported_at: chrono::DateTime<chrono::Utc>,
    pub account: Value,
    pub library: Vec<Value>,
    pub watch_history: Vec<Value>,
    pub lists: Vec<Value>,
    pub relationships: Vec<Value>,
    pub episode_plans: Vec<Value>,
    pub episode_reactions: Vec<Value>,
    pub notifications: Vec<Value>,
    pub sessions: Vec<Value>,
    pub notification_devices: Vec<Value>,
    pub import_jobs: Vec<Value>,
    pub calendar_preferences: Option<Value>,
    pub oauth_accounts: Vec<Value>,
    pub security_activity: Vec<Value>,
    pub terms_acceptances: Vec<Value>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use validator::Validate;

    #[test]
    fn test_profile_all_none_valid() {
        let req = UpdateProfileRequest {
            username: None,
            bio: None,
            is_public: None,
        };
        assert!(req.validate().is_ok());
    }

    #[test]
    fn test_profile_username_too_short() {
        let req = UpdateProfileRequest {
            username: Some("ab".to_string()),
            bio: None,
            is_public: None,
        };
        assert!(req.validate().is_err());
    }

    #[test]
    fn test_profile_username_too_long() {
        let req = UpdateProfileRequest {
            username: Some("a".repeat(51)),
            bio: None,
            is_public: None,
        };
        assert!(req.validate().is_err());
    }

    #[test]
    fn test_profile_blank_username_rejected() {
        let req = UpdateProfileRequest {
            username: Some("   ".to_string()),
            bio: None,
            is_public: None,
        };
        assert!(req.validate().is_err());
    }

    #[test]
    fn test_profile_bio_too_long() {
        let req = UpdateProfileRequest {
            username: None,
            bio: Some("x".repeat(501)),
            is_public: None,
        };
        assert!(req.validate().is_err());
    }

    #[test]
    fn test_profile_bio_exactly_500() {
        let req = UpdateProfileRequest {
            username: None,
            bio: Some("x".repeat(500)),
            is_public: None,
        };
        assert!(req.validate().is_ok());
    }

    #[test]
    fn test_profile_valid_complete() {
        let req = UpdateProfileRequest {
            username: Some("newuser".to_string()),
            bio: Some("Hello world".to_string()),
            is_public: Some(true),
        };
        assert!(req.validate().is_ok());
    }

    #[test]
    fn test_delete_account_password_is_bounded() {
        assert!(DeleteAccountRequest {
            password: "x".repeat(128),
            totp_code: None,
        }
        .validate()
        .is_ok());
        assert!(DeleteAccountRequest {
            password: "x".repeat(129),
            totp_code: None,
        }
        .validate()
        .is_err());
    }

    #[test]
    fn delete_account_rejects_unknown_fields() {
        assert!(
            serde_json::from_value::<DeleteAccountRequest>(serde_json::json!({
                "password": "SecurePass1",
                "user_id": uuid::Uuid::new_v4()
            }))
            .is_err()
        );
    }

    #[test]
    fn data_export_requires_a_bounded_password_and_rejects_extra_fields() {
        assert!(DataExportRequest {
            password: "x".repeat(128),
            totp_code: None,
        }
        .validate()
        .is_ok());
        assert!(DataExportRequest {
            password: "x".repeat(129),
            totp_code: None,
        }
        .validate()
        .is_err());
        assert!(
            serde_json::from_value::<DataExportRequest>(serde_json::json!({
                "password": "SecurePass1",
                "include_secrets": true
            }))
            .is_err()
        );
    }
}
