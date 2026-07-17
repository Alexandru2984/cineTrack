use chrono::{DateTime, Utc};
use serde::Deserialize;
use validator::Validate;

fn validate_non_blank(value: &str) -> Result<(), validator::ValidationError> {
    if value.trim().is_empty() {
        return Err(validator::ValidationError::new("blank"));
    }
    Ok(())
}

fn validate_app_version(value: &str) -> Result<(), validator::ValidationError> {
    if value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'+' | b'-' | b'_'))
    {
        return Ok(());
    }
    Err(validator::ValidationError::new("invalid_app_version"))
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ClientPlatform {
    Android,
    Ios,
}

impl ClientPlatform {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Android => "android",
            Self::Ios => "ios",
        }
    }
}

#[derive(Debug, Deserialize, Validate)]
#[serde(deny_unknown_fields)]
pub struct ClientErrorReport {
    #[validate(length(min = 1, max = 120), custom(function = "validate_non_blank"))]
    pub error_name: String,
    #[validate(length(min = 1, max = 1000), custom(function = "validate_non_blank"))]
    pub message: String,
    #[validate(length(max = 16_000))]
    pub stack: Option<String>,
    #[validate(length(max = 8_000))]
    pub component_stack: Option<String>,
    pub platform: ClientPlatform,
    #[validate(
        length(min = 1, max = 32),
        custom(function = "validate_non_blank"),
        custom(function = "validate_app_version")
    )]
    pub app_version: String,
    pub is_fatal: bool,
    pub occurred_at: DateTime<Utc>,
}
