use serde::Deserialize;
use validator::Validate;

fn validate_avatar_url(url: &str) -> Result<(), validator::ValidationError> {
    if url.is_empty() {
        return Ok(());
    }
    if !url.starts_with("https://") && !url.starts_with("http://") {
        let mut err = validator::ValidationError::new("invalid_url");
        err.message = Some("Avatar URL must start with https:// or http://".into());
        return Err(err);
    }
    if url.len() > 500 {
        let mut err = validator::ValidationError::new("url_too_long");
        err.message = Some("Avatar URL must be at most 500 characters".into());
        return Err(err);
    }
    Ok(())
}

#[derive(Debug, Deserialize, Validate)]
pub struct UpdateProfileRequest {
    #[validate(length(min = 3, max = 50))]
    pub username: Option<String>,
    #[validate(length(max = 500, message = "Bio must be at most 500 characters"))]
    pub bio: Option<String>,
    #[validate(custom(function = "validate_avatar_url"))]
    pub avatar_url: Option<String>,
    pub is_public: Option<bool>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use validator::Validate;

    // --- Avatar URL validator ---

    #[test]
    fn test_avatar_url_https_valid() {
        assert!(validate_avatar_url("https://example.com/avatar.png").is_ok());
    }

    #[test]
    fn test_avatar_url_http_valid() {
        assert!(validate_avatar_url("http://example.com/avatar.png").is_ok());
    }

    #[test]
    fn test_avatar_url_empty_valid() {
        assert!(validate_avatar_url("").is_ok());
    }

    #[test]
    fn test_avatar_url_javascript_rejected() {
        assert!(validate_avatar_url("javascript:alert(1)").is_err());
    }

    #[test]
    fn test_avatar_url_data_rejected() {
        assert!(validate_avatar_url("data:image/png;base64,abc").is_err());
    }

    #[test]
    fn test_avatar_url_ftp_rejected() {
        assert!(validate_avatar_url("ftp://example.com/file").is_err());
    }

    #[test]
    fn test_avatar_url_no_protocol_rejected() {
        assert!(validate_avatar_url("example.com/avatar.png").is_err());
    }

    #[test]
    fn test_avatar_url_too_long_rejected() {
        let long_url = format!("https://example.com/{}", "a".repeat(500));
        assert!(long_url.len() > 500);
        assert!(validate_avatar_url(&long_url).is_err());
    }

    #[test]
    fn test_avatar_url_exactly_500_chars() {
        // https://x.co/ = 13 chars, need 487 more
        let url = format!("https://x.co/{}", "a".repeat(487));
        assert_eq!(url.len(), 500);
        assert!(validate_avatar_url(&url).is_ok());
    }

    // --- UpdateProfileRequest validation ---

    #[test]
    fn test_profile_all_none_valid() {
        let req = UpdateProfileRequest {
            username: None, bio: None, avatar_url: None, is_public: None,
        };
        assert!(req.validate().is_ok());
    }

    #[test]
    fn test_profile_username_too_short() {
        let req = UpdateProfileRequest {
            username: Some("ab".to_string()), bio: None, avatar_url: None, is_public: None,
        };
        assert!(req.validate().is_err());
    }

    #[test]
    fn test_profile_username_too_long() {
        let req = UpdateProfileRequest {
            username: Some("a".repeat(51)), bio: None, avatar_url: None, is_public: None,
        };
        assert!(req.validate().is_err());
    }

    #[test]
    fn test_profile_bio_too_long() {
        let req = UpdateProfileRequest {
            username: None, bio: Some("x".repeat(501)), avatar_url: None, is_public: None,
        };
        assert!(req.validate().is_err());
    }

    #[test]
    fn test_profile_bio_exactly_500() {
        let req = UpdateProfileRequest {
            username: None, bio: Some("x".repeat(500)), avatar_url: None, is_public: None,
        };
        assert!(req.validate().is_ok());
    }

    #[test]
    fn test_profile_bad_avatar_url() {
        let req = UpdateProfileRequest {
            username: None, bio: None, avatar_url: Some("javascript:alert(1)".to_string()), is_public: None,
        };
        assert!(req.validate().is_err());
    }

    #[test]
    fn test_profile_valid_complete() {
        let req = UpdateProfileRequest {
            username: Some("newuser".to_string()),
            bio: Some("Hello world".to_string()),
            avatar_url: Some("https://example.com/pic.jpg".to_string()),
            is_public: Some(true),
        };
        assert!(req.validate().is_ok());
    }
}
