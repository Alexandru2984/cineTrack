use serde::Deserialize;
use validator::{Validate, ValidationError};

fn validate_expo_push_token(value: &str) -> Result<(), ValidationError> {
    let inner = value
        .strip_prefix("ExpoPushToken[")
        .or_else(|| value.strip_prefix("ExponentPushToken["))
        .and_then(|token| token.strip_suffix(']'))
        .ok_or_else(|| ValidationError::new("invalid_expo_push_token"))?;
    if (10..=200).contains(&inner.len())
        && inner
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Ok(());
    }
    Err(ValidationError::new("invalid_expo_push_token"))
}

fn validate_unregister_secret(value: &str) -> Result<(), ValidationError> {
    if value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Ok(());
    }
    Err(ValidationError::new("invalid_unregister_secret"))
}

fn validate_app_version(value: &str) -> Result<(), ValidationError> {
    if !value.is_empty()
        && value.len() <= 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'+' | b'-' | b'_'))
    {
        return Ok(());
    }
    Err(ValidationError::new("invalid_app_version"))
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PushPlatform {
    Android,
    Ios,
}

impl PushPlatform {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Android => "android",
            Self::Ios => "ios",
        }
    }
}

#[derive(Debug, Deserialize, Validate)]
#[serde(deny_unknown_fields)]
pub struct RegisterPushDeviceRequest {
    #[validate(custom(function = "validate_expo_push_token"))]
    pub expo_push_token: String,
    #[validate(custom(function = "validate_unregister_secret"))]
    pub unregister_secret: String,
    pub platform: PushPlatform,
    #[validate(custom(function = "validate_app_version"))]
    pub app_version: String,
    #[validate(range(min = -840, max = 840))]
    pub utc_offset_minutes: i16,
}

#[derive(Debug, Deserialize, Validate)]
#[serde(deny_unknown_fields)]
pub struct RevokePushDeviceRequest {
    #[validate(custom(function = "validate_expo_push_token"))]
    pub expo_push_token: String,
    #[validate(custom(function = "validate_unregister_secret"))]
    pub unregister_secret: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_both_expo_token_prefixes() {
        for token in [
            "ExpoPushToken[abcdefghijklmnopqrstuv]",
            "ExponentPushToken[abcdefghijklmnopqrstuv]",
        ] {
            assert!(validate_expo_push_token(token).is_ok());
        }
        assert!(validate_expo_push_token("not-a-token").is_err());
    }

    #[test]
    fn unregister_secret_is_lowercase_hex() {
        assert!(validate_unregister_secret(&"a1".repeat(32)).is_ok());
        assert!(validate_unregister_secret(&"A1".repeat(32)).is_err());
        assert!(validate_unregister_secret("short").is_err());
    }
}
