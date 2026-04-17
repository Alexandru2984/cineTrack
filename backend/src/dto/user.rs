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
