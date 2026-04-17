use serde::{Deserialize, Serialize};
use validator::Validate;

#[derive(Debug, Deserialize, Validate)]
pub struct RegisterRequest {
    #[validate(length(min = 3, max = 50, message = "Username must be 3-50 characters"))]
    pub username: String,
    #[validate(email(message = "Invalid email address"))]
    pub email: String,
    #[validate(length(min = 8, max = 128, message = "Password must be 8-128 characters"), custom(function = "validate_password_strength"))]
    pub password: String,
}

fn validate_password_strength(password: &str) -> Result<(), validator::ValidationError> {
    let has_letter = password.chars().any(|c| c.is_alphabetic());
    let has_digit = password.chars().any(|c| c.is_ascii_digit());
    if !has_letter || !has_digit {
        let mut err = validator::ValidationError::new("weak_password");
        err.message = Some("Password must contain at least one letter and one digit".into());
        return Err(err);
    }
    let first = password.chars().next().unwrap();
    if password.chars().all(|c| c == first) {
        let mut err = validator::ValidationError::new("weak_password");
        err.message = Some("Password cannot be all the same character".into());
        return Err(err);
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
}

#[derive(Debug, Serialize)]
pub struct AuthResponse {
    pub access_token: String,
    pub refresh_token: String,
    pub token_type: String,
    pub expires_in: i64,
    pub user: UserResponse,
}

#[derive(Debug, Serialize)]
pub struct UserResponse {
    pub id: uuid::Uuid,
    pub username: String,
    pub email: String,
    pub avatar_url: Option<String>,
    pub bio: Option<String>,
    pub is_public: bool,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

impl From<crate::models::User> for UserResponse {
    fn from(user: crate::models::User) -> Self {
        Self {
            id: user.id,
            username: user.username,
            email: user.email,
            avatar_url: user.avatar_url,
            bio: user.bio,
            is_public: user.is_public,
            created_at: user.created_at,
        }
    }
}

/// Lightweight user info without email — for public-facing lists (followers, etc.)
#[derive(Debug, Serialize)]
pub struct UserSummary {
    pub id: uuid::Uuid,
    pub username: String,
    pub avatar_url: Option<String>,
    pub bio: Option<String>,
}

impl From<crate::models::User> for UserSummary {
    fn from(user: crate::models::User) -> Self {
        Self {
            id: user.id,
            username: user.username,
            avatar_url: user.avatar_url,
            bio: user.bio,
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct RefreshRequest {
    pub refresh_token: String,
}

#[derive(Debug, Deserialize)]
pub struct LogoutRequest {
    pub refresh_token: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use validator::Validate;

    // --- Password strength validator tests ---

    #[test]
    fn test_password_valid() {
        assert!(validate_password_strength("MyPass123").is_ok());
    }

    #[test]
    fn test_password_valid_complex() {
        assert!(validate_password_strength("C0mpl3x!P@ss").is_ok());
    }

    #[test]
    fn test_password_no_digit() {
        assert!(validate_password_strength("OnlyLetters").is_err());
    }

    #[test]
    fn test_password_no_letter() {
        assert!(validate_password_strength("12345678").is_err());
    }

    #[test]
    fn test_password_all_same_char() {
        assert!(validate_password_strength("aaaaaaaa").is_err());
    }

    #[test]
    fn test_password_all_same_digit() {
        assert!(validate_password_strength("11111111").is_err());
    }

    #[test]
    fn test_password_mixed_but_all_same() {
        // All same character — even if it looks complex, rejects
        assert!(validate_password_strength("aaaaaaaa").is_err());
    }

    #[test]
    fn test_password_minimum_valid() {
        // Exactly 1 letter + 1 digit + not all same
        assert!(validate_password_strength("a1b2c3d4").is_ok());
    }

    // --- RegisterRequest validation tests ---

    #[test]
    fn test_register_valid() {
        let req = RegisterRequest {
            username: "testuser".to_string(),
            email: "test@example.com".to_string(),
            password: "SecurePass1".to_string(),
        };
        assert!(req.validate().is_ok());
    }

    #[test]
    fn test_register_username_too_short() {
        let req = RegisterRequest {
            username: "ab".to_string(),
            email: "test@example.com".to_string(),
            password: "SecurePass1".to_string(),
        };
        assert!(req.validate().is_err());
    }

    #[test]
    fn test_register_username_too_long() {
        let req = RegisterRequest {
            username: "a".repeat(51),
            email: "test@example.com".to_string(),
            password: "SecurePass1".to_string(),
        };
        assert!(req.validate().is_err());
    }

    #[test]
    fn test_register_invalid_email() {
        let req = RegisterRequest {
            username: "testuser".to_string(),
            email: "not-an-email".to_string(),
            password: "SecurePass1".to_string(),
        };
        assert!(req.validate().is_err());
    }

    #[test]
    fn test_register_password_too_short() {
        let req = RegisterRequest {
            username: "testuser".to_string(),
            email: "test@example.com".to_string(),
            password: "Short1".to_string(),
        };
        assert!(req.validate().is_err());
    }

    #[test]
    fn test_register_password_too_long() {
        let req = RegisterRequest {
            username: "testuser".to_string(),
            email: "test@example.com".to_string(),
            password: format!("{}1", "a".repeat(128)),
        };
        assert!(req.validate().is_err());
    }

    #[test]
    fn test_register_password_no_digit_fails_custom() {
        let req = RegisterRequest {
            username: "testuser".to_string(),
            email: "test@example.com".to_string(),
            password: "OnlyLettersHere".to_string(),
        };
        assert!(req.validate().is_err());
    }

    #[test]
    fn test_register_password_no_letter_fails_custom() {
        let req = RegisterRequest {
            username: "testuser".to_string(),
            email: "test@example.com".to_string(),
            password: "123456789".to_string(),
        };
        assert!(req.validate().is_err());
    }

    #[test]
    fn test_register_username_boundary_3_chars() {
        let req = RegisterRequest {
            username: "abc".to_string(),
            email: "test@example.com".to_string(),
            password: "SecurePass1".to_string(),
        };
        assert!(req.validate().is_ok());
    }

    #[test]
    fn test_register_username_boundary_50_chars() {
        let req = RegisterRequest {
            username: "a".repeat(50),
            email: "test@example.com".to_string(),
            password: "SecurePass1".to_string(),
        };
        assert!(req.validate().is_ok());
    }

    #[test]
    fn test_register_password_boundary_8_chars() {
        let req = RegisterRequest {
            username: "testuser".to_string(),
            email: "test@example.com".to_string(),
            password: "Abcdef1x".to_string(), // exactly 8
        };
        assert!(req.validate().is_ok());
    }
}
