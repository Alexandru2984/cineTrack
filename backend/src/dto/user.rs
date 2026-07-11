use serde::Deserialize;
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
pub struct DeleteAccountRequest {
    #[validate(length(min = 1, message = "Password is required"))]
    pub password: String,
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
}
