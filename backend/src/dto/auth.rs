use serde::{Deserialize, Serialize};
use validator::Validate;

use crate::dto::validation::validate_username;
use crate::utils::jwt::is_valid_refresh_token;

fn validate_refresh_token(token: &str) -> Result<(), validator::ValidationError> {
    if is_valid_refresh_token(token) {
        return Ok(());
    }

    let mut err = validator::ValidationError::new("invalid_token");
    err.message = Some("Invalid token".into());
    Err(err)
}

#[derive(Debug, Deserialize, Validate)]
#[serde(deny_unknown_fields)]
pub struct RegisterRequest {
    #[validate(
        length(min = 3, max = 50, message = "Username must be 3-50 characters"),
        custom(function = "validate_username")
    )]
    pub username: String,
    #[validate(
        length(max = 254, message = "Email must be at most 254 characters"),
        email(message = "Invalid email address"),
        custom(function = "validate_deliverable_email")
    )]
    pub email: String,
    #[validate(
        length(min = 8, max = 128, message = "Password must be 8-128 characters"),
        custom(function = "validate_password_strength")
    )]
    pub password: String,
    pub accepted_terms: bool,
    /// Self-attested confirmation of the minimum age. Direct messages, public
    /// profiles and free-text fields put this service above the GDPR Art. 8
    /// consent age, so the account cannot be created without it.
    pub confirmed_minimum_age: bool,
}

/// Domains the standards permanently reserve for documentation and testing.
///
/// RFC 2606 reserves the three second-level names, RFC 6761 the four top-level
/// ones. None of them has, or can ever have, a mail server: every message sent
/// to one is a bounce, charged against the sending domain's reputation.
///
/// A closed list defined by a standard, unlike a list of disposable-mail
/// providers, which is an endless race nobody wins.
const RESERVED_EMAIL_DOMAINS: &[&str] = &["example.com", "example.net", "example.org"];
const RESERVED_EMAIL_TLDS: &[&str] = &[".test", ".example", ".invalid", ".localhost", ".local"];

/// Refuse an address that provably cannot receive mail.
///
/// Accounts on these domains have reached production: `testuser123@example.com`
/// signed up and its verification mail could only ever bounce. Each one spends
/// deliverability that real users then pay for.
///
/// Applied where an address must be reachable for the account to work — signing
/// up, and changing an address. Deliberately not applied to signing in or to
/// password resets: an existing account must not become unusable because the
/// rules tightened, and a reset has to answer identically for every address, or
/// the difference reveals which ones exist.
fn validate_deliverable_email(email: &str) -> Result<(), validator::ValidationError> {
    let Some((_, domain)) = email.rsplit_once('@') else {
        // Malformed, which the `email` validator on the same field reports.
        return Ok(());
    };
    let domain = domain.trim().trim_end_matches('.').to_ascii_lowercase();

    let reserved = RESERVED_EMAIL_DOMAINS
        .iter()
        .any(|name| domain == *name || domain.ends_with(&format!(".{name}")))
        || RESERVED_EMAIL_TLDS
            .iter()
            .any(|tld| domain.ends_with(tld) || domain == tld.trim_start_matches('.'));

    if reserved {
        let mut err = validator::ValidationError::new("undeliverable_email");
        err.message = Some("That email domain cannot receive mail".into());
        return Err(err);
    }
    Ok(())
}

fn validate_password_strength(password: &str) -> Result<(), validator::ValidationError> {
    let has_letter = password.chars().any(|c| c.is_alphabetic());
    let has_digit = password.chars().any(|c| c.is_ascii_digit());
    if !has_letter || !has_digit {
        let mut err = validator::ValidationError::new("weak_password");
        err.message = Some("Password must contain at least one letter and one digit".into());
        return Err(err);
    }
    if password.is_empty() {
        let mut err = validator::ValidationError::new("weak_password");
        err.message = Some("Password cannot be empty".into());
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

#[derive(Debug, Deserialize, Validate)]
#[serde(deny_unknown_fields)]
pub struct LoginRequest {
    #[validate(
        length(max = 254, message = "Email must be at most 254 characters"),
        email(message = "Invalid email address")
    )]
    pub email: String,
    #[validate(length(min = 1, max = 128, message = "Password must be 1-128 characters"))]
    pub password: String,
    /// Present on the second step when the account has 2FA enabled: either a
    /// 6-digit TOTP code or a recovery code.
    #[validate(length(max = 64, message = "Two-factor code is too long"))]
    pub totp_code: Option<String>,
}

#[derive(Debug, Deserialize, Validate)]
#[serde(deny_unknown_fields)]
pub struct SetupTwoFactorRequest {
    #[validate(length(min = 1, max = 128, message = "Password must be 1-128 characters"))]
    pub password: String,
}

#[derive(Debug, Serialize)]
pub struct TwoFactorSetupResponse {
    /// Base32 secret for manual entry when a QR scan isn't possible.
    pub secret: String,
    /// `otpauth://` provisioning URI the client renders as a QR code.
    pub otpauth_uri: String,
}

#[derive(Debug, Deserialize, Validate)]
#[serde(deny_unknown_fields)]
pub struct EnableTwoFactorRequest {
    #[validate(length(equal = 6, message = "Enter the 6-digit code"))]
    pub code: String,
}

#[derive(Debug, Serialize)]
pub struct TwoFactorEnabledResponse {
    /// One-time recovery codes, shown exactly once at activation.
    pub recovery_codes: Vec<String>,
}

#[derive(Debug, Deserialize, Validate)]
#[serde(deny_unknown_fields)]
pub struct DisableTwoFactorRequest {
    #[validate(length(min = 1, max = 128, message = "Password must be 1-128 characters"))]
    pub password: String,
    #[validate(length(max = 64, message = "Two-factor code is too long"))]
    pub totp_code: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct AuthResponse {
    pub access_token: String,
    pub token_type: String,
    pub expires_in: i64,
    pub user: UserResponse,
}

#[derive(Debug, Serialize)]
pub struct MobileAuthResponse {
    #[serde(flatten)]
    pub auth: AuthResponse,
    pub refresh_token: String,
}

impl MobileAuthResponse {
    pub fn new(auth: AuthResponse, refresh_token: String) -> Self {
        Self {
            auth,
            refresh_token,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct UserResponse {
    pub id: uuid::Uuid,
    pub username: String,
    pub email: String,
    pub avatar_url: Option<String>,
    pub bio: Option<String>,
    pub is_public: bool,
    pub email_verified: bool,
    pub two_factor_enabled: bool,
    pub terms_accepted_version: Option<String>,
    pub terms_accepted_at: Option<chrono::DateTime<chrono::Utc>>,
    pub current_terms_version: &'static str,
    pub terms_acceptance_required: bool,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

impl From<crate::models::User> for UserResponse {
    fn from(user: crate::models::User) -> Self {
        let terms_acceptance_required = user.terms_accepted_version.as_deref()
            != Some(crate::services::legal::CURRENT_TERMS_VERSION);
        Self {
            id: user.id,
            username: user.username,
            email: user.email,
            avatar_url: user.avatar_url,
            bio: user.bio,
            is_public: user.is_public,
            email_verified: user.email_verified,
            two_factor_enabled: user.totp_enabled,
            terms_accepted_version: user.terms_accepted_version,
            terms_accepted_at: user.terms_accepted_at,
            current_terms_version: crate::services::legal::CURRENT_TERMS_VERSION,
            terms_acceptance_required,
            created_at: user.created_at,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AcceptTermsRequest {
    pub accepted_terms: bool,
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

#[derive(Debug, Deserialize, Validate)]
#[serde(deny_unknown_fields)]
pub struct ChangePasswordRequest {
    #[validate(length(
        min = 1,
        max = 128,
        message = "Current password must be 1-128 characters"
    ))]
    pub current_password: String,
    #[validate(
        length(min = 8, max = 128, message = "Password must be 8-128 characters"),
        custom(function = "validate_password_strength")
    )]
    pub new_password: String,
    #[validate(length(max = 64, message = "Two-factor code is too long"))]
    pub totp_code: Option<String>,
}

/// The current password is required even though the caller is already
/// authenticated. A live session is enough to read the account; moving the
/// address that recovers it should cost more than that.
#[derive(Debug, Deserialize, Validate)]
#[serde(deny_unknown_fields)]
pub struct ChangeEmailRequest {
    #[validate(length(
        min = 1,
        max = 128,
        message = "Current password must be 1-128 characters"
    ))]
    pub current_password: String,
    #[validate(
        length(max = 254, message = "Email must be at most 254 characters"),
        email(message = "Invalid email address"),
        custom(function = "validate_deliverable_email")
    )]
    pub new_email: String,
    #[validate(length(max = 64, message = "Two-factor code is too long"))]
    pub totp_code: Option<String>,
}

#[derive(Debug, Deserialize, Validate)]
#[serde(deny_unknown_fields)]
pub struct ConfirmEmailChangeRequest {
    #[validate(length(min = 1, max = 512, message = "Invalid token"))]
    pub token: String,
}

#[derive(Debug, Deserialize, Validate)]
#[serde(deny_unknown_fields)]
pub struct ForgotPasswordRequest {
    #[validate(
        length(max = 254, message = "Email must be at most 254 characters"),
        email(message = "Invalid email address")
    )]
    pub email: String,
}

#[derive(Debug, Deserialize, Validate)]
#[serde(deny_unknown_fields)]
pub struct ResetPasswordRequest {
    #[validate(custom(function = "validate_refresh_token"))]
    pub token: String,
    #[validate(
        length(min = 8, max = 128, message = "Password must be 8-128 characters"),
        custom(function = "validate_password_strength")
    )]
    pub new_password: String,
}

/// A single active login (non-consumed, non-revoked, unexpired refresh token).
#[derive(Debug, Serialize)]
pub struct SessionResponse {
    pub id: uuid::Uuid,
    pub user_agent: Option<String>,
    pub ip_address: Option<String>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub last_used_at: Option<chrono::DateTime<chrono::Utc>>,
    /// True for the session making the request (matched by refresh-cookie hash).
    pub current: bool,
}

#[derive(Debug, Deserialize, Validate)]
#[serde(deny_unknown_fields)]
pub struct VerifyEmailRequest {
    #[validate(custom(function = "validate_refresh_token"))]
    pub token: String,
}

#[derive(Debug, Deserialize, Validate)]
#[serde(deny_unknown_fields)]
pub struct RefreshRequest {
    #[validate(custom(function = "validate_refresh_token"))]
    pub refresh_token: String,
}

#[derive(Debug, Deserialize, Validate)]
#[serde(deny_unknown_fields)]
pub struct LogoutRequest {
    #[validate(custom(function = "validate_refresh_token"))]
    pub refresh_token: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use validator::Validate;

    fn email_with_domain_labels(label_lengths: &[usize]) -> String {
        let domain = label_lengths
            .iter()
            .map(|length| "b".repeat(*length))
            .collect::<Vec<_>>()
            .join(".");
        format!("{}@{domain}", "a".repeat(64))
    }

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
    fn test_password_empty_rejected_without_panic() {
        assert!(validate_password_strength("").is_err());
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
            email: "test@mailbox.dev".to_string(),
            password: "SecurePass1".to_string(),
            accepted_terms: true,
            confirmed_minimum_age: true,
        };
        assert!(req.validate().is_ok());
    }

    #[test]
    fn auth_payloads_reject_unknown_fields() {
        assert!(
            serde_json::from_value::<RegisterRequest>(serde_json::json!({
                "username": "testuser",
                "email": "test@mailbox.dev",
                "password": "SecurePass1",
                "accepted_terms": true,
                "confirmed_minimum_age": true,
                "admin": true
            }))
            .is_err()
        );
        assert!(serde_json::from_value::<LoginRequest>(serde_json::json!({
            "email": "test@mailbox.dev",
            "password": "SecurePass1",
            "remember_me": true
        }))
        .is_err());
        assert!(
            serde_json::from_value::<ChangePasswordRequest>(serde_json::json!({
                "current_password": "SecurePass1",
                "new_password": "NewSecurePass2",
                "user_id": uuid::Uuid::new_v4()
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<ForgotPasswordRequest>(serde_json::json!({
                "email": "test@mailbox.dev",
                "redirect_url": "https://attacker.invalid"
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<ResetPasswordRequest>(serde_json::json!({
                "token": "a".repeat(128),
                "new_password": "NewSecurePass2",
                "keep_sessions": true
            }))
            .is_err()
        );
    }

    #[test]
    fn terms_acceptance_payload_rejects_unknown_fields() {
        assert!(
            serde_json::from_value::<AcceptTermsRequest>(serde_json::json!({
                "accepted_terms": true,
                "terms_version": "attacker-selected"
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<AcceptTermsRequest>(serde_json::json!({
                "accepted_terms": true
            }))
            .is_ok()
        );
    }

    #[test]
    fn test_register_username_too_short() {
        let req = RegisterRequest {
            username: "ab".to_string(),
            email: "test@mailbox.dev".to_string(),
            password: "SecurePass1".to_string(),
            accepted_terms: true,
            confirmed_minimum_age: true,
        };
        assert!(req.validate().is_err());
    }

    #[test]
    fn test_register_username_too_long() {
        let req = RegisterRequest {
            username: "a".repeat(51),
            email: "test@mailbox.dev".to_string(),
            password: "SecurePass1".to_string(),
            accepted_terms: true,
            confirmed_minimum_age: true,
        };
        assert!(req.validate().is_err());
    }

    #[test]
    fn test_register_blank_username_rejected() {
        let req = RegisterRequest {
            username: "   ".to_string(),
            email: "test@mailbox.dev".to_string(),
            password: "SecurePass1".to_string(),
            accepted_terms: true,
            confirmed_minimum_age: true,
        };
        assert!(req.validate().is_err());
    }

    #[test]
    fn test_register_invalid_email() {
        let req = RegisterRequest {
            username: "testuser".to_string(),
            email: "not-an-email".to_string(),
            password: "SecurePass1".to_string(),
            accepted_terms: true,
            confirmed_minimum_age: true,
        };
        assert!(req.validate().is_err());
    }

    #[test]
    fn test_register_password_too_short() {
        let req = RegisterRequest {
            username: "testuser".to_string(),
            email: "test@mailbox.dev".to_string(),
            password: "Short1".to_string(),
            accepted_terms: true,
            confirmed_minimum_age: true,
        };
        assert!(req.validate().is_err());
    }

    #[test]
    fn test_register_password_too_long() {
        let req = RegisterRequest {
            username: "testuser".to_string(),
            email: "test@mailbox.dev".to_string(),
            password: format!("{}1", "a".repeat(128)),
            accepted_terms: true,
            confirmed_minimum_age: true,
        };
        assert!(req.validate().is_err());
    }

    #[test]
    fn test_register_password_no_digit_fails_custom() {
        let req = RegisterRequest {
            username: "testuser".to_string(),
            email: "test@mailbox.dev".to_string(),
            password: "OnlyLettersHere".to_string(),
            accepted_terms: true,
            confirmed_minimum_age: true,
        };
        assert!(req.validate().is_err());
    }

    #[test]
    fn test_register_password_no_letter_fails_custom() {
        let req = RegisterRequest {
            username: "testuser".to_string(),
            email: "test@mailbox.dev".to_string(),
            password: "123456789".to_string(),
            accepted_terms: true,
            confirmed_minimum_age: true,
        };
        assert!(req.validate().is_err());
    }

    #[test]
    fn test_register_username_boundary_3_chars() {
        let req = RegisterRequest {
            username: "abc".to_string(),
            email: "test@mailbox.dev".to_string(),
            password: "SecurePass1".to_string(),
            accepted_terms: true,
            confirmed_minimum_age: true,
        };
        assert!(req.validate().is_ok());
    }

    #[test]
    fn test_register_username_boundary_50_chars() {
        let req = RegisterRequest {
            username: "a".repeat(50),
            email: "test@mailbox.dev".to_string(),
            password: "SecurePass1".to_string(),
            accepted_terms: true,
            confirmed_minimum_age: true,
        };
        assert!(req.validate().is_ok());
    }

    #[test]
    fn test_register_password_boundary_8_chars() {
        let req = RegisterRequest {
            username: "testuser".to_string(),
            email: "test@mailbox.dev".to_string(),
            password: "Abcdef1x".to_string(), // exactly 8
            accepted_terms: true,
            confirmed_minimum_age: true,
        };
        assert!(req.validate().is_ok());
    }

    #[test]
    fn test_register_email_boundary_254_chars() {
        let email = email_with_domain_labels(&[63, 63, 61]);
        assert_eq!(email.chars().count(), 254);
        let req = RegisterRequest {
            username: "testuser".to_string(),
            email,
            password: "SecurePass1".to_string(),
            accepted_terms: true,
            confirmed_minimum_age: true,
        };
        assert!(req.validate().is_ok());
    }

    #[test]
    fn test_auth_requests_reject_email_over_254_chars() {
        let email = email_with_domain_labels(&[63, 63, 62]);
        assert_eq!(email.chars().count(), 255);

        assert!(RegisterRequest {
            username: "testuser".to_string(),
            email: email.clone(),
            password: "SecurePass1".to_string(),
            accepted_terms: true,
            confirmed_minimum_age: true,
        }
        .validate()
        .is_err());
        assert!(LoginRequest {
            email: email.clone(),
            password: "SecurePass1".to_string(),
            totp_code: None,
        }
        .validate()
        .is_err());
        assert!(ForgotPasswordRequest { email }.validate().is_err());
    }

    #[test]
    fn test_change_password_caps_current_password() {
        let req = ChangePasswordRequest {
            current_password: "x".repeat(129),
            new_password: "SecurePass1".to_string(),
            totp_code: None,
        };
        assert!(req.validate().is_err());
    }

    #[test]
    fn change_email_requires_a_real_address_and_a_password() {
        let valid = ChangeEmailRequest {
            current_password: "SecurePass1".to_string(),
            new_email: "new@mailbox.dev".to_string(),
            totp_code: None,
        };
        assert!(valid.validate().is_ok());

        // No password means a stolen session alone could move the address.
        let no_password = ChangeEmailRequest {
            current_password: String::new(),
            new_email: "new@mailbox.dev".to_string(),
            totp_code: None,
        };
        assert!(no_password.validate().is_err());

        let malformed = ChangeEmailRequest {
            current_password: "SecurePass1".to_string(),
            new_email: "not-an-address".to_string(),
            totp_code: None,
        };
        assert!(malformed.validate().is_err());

        let too_long = ChangeEmailRequest {
            current_password: "SecurePass1".to_string(),
            new_email: format!("{}@mailbox.dev", "a".repeat(250)),
            totp_code: None,
        };
        assert!(too_long.validate().is_err());
    }

    #[test]
    fn change_email_payloads_reject_unknown_fields() {
        assert!(
            serde_json::from_value::<ChangeEmailRequest>(serde_json::json!({
                "current_password": "SecurePass1",
                "new_email": "new@mailbox.dev",
                "email_verified": true
            }))
            .is_err()
        );
    }

    #[test]
    fn test_reset_password_requires_generated_token_shape() {
        let valid = ResetPasswordRequest {
            token: "a".repeat(128),
            new_password: "SecurePass1".to_string(),
        };
        assert!(valid.validate().is_ok());

        let short = ResetPasswordRequest {
            token: "a".repeat(127),
            new_password: "SecurePass1".to_string(),
        };
        assert!(short.validate().is_err());

        let non_hex = ResetPasswordRequest {
            token: "z".repeat(128),
            new_password: "SecurePass1".to_string(),
        };
        assert!(non_hex.validate().is_err());
    }

    /// Every address in this list bounced against the production sending domain
    /// before the check existed, or is reserved by the same standards as the
    /// ones that did. A bounce costs deliverability that real users then pay
    /// for, so the account is refused rather than the mail wasted.
    #[test]
    fn registration_refuses_domains_that_cannot_receive_mail() {
        for address in [
            "testuser123@example.com",
            "someone@example.net",
            "someone@example.org",
            "wsprobe_1786230837@example.test",
            "someone@mail.example.com",
            "someone@anything.invalid",
            "someone@dev.localhost",
            "someone@printer.local",
            "SOMEONE@EXAMPLE.COM",
            "someone@example.com.",
        ] {
            assert!(
                validate_deliverable_email(address).is_err(),
                "{address} should have been refused"
            );
        }
    }

    /// The list is closed and comes from the standards. Anything else is a real
    /// domain someone might genuinely use, including ones that merely look like
    /// test addresses.
    #[test]
    fn registration_accepts_addresses_that_can_receive_mail() {
        for address in [
            "hans@gmx.de",
            "someone@gmail.com",
            "someone@ex.com",
            "someone@examples.com",
            "someone@example.company",
            "someone@testing.dev",
            "play-review@micutu.com",
            "no-at-sign-here",
        ] {
            assert!(
                validate_deliverable_email(address).is_ok(),
                "{address} should have been accepted"
            );
        }
    }

    /// Signing in and asking for a reset must not consult the list. An account
    /// created before it existed has to stay usable, and a reset that answered
    /// differently for reserved domains would confirm which addresses exist.
    #[test]
    fn signing_in_and_resetting_ignore_the_reserved_list() {
        let login = LoginRequest {
            email: "testuser123@example.com".into(),
            password: "whatever123".into(),
            totp_code: None,
        };
        assert!(login.validate().is_ok());

        let forgot = ForgotPasswordRequest {
            email: "testuser123@example.com".into(),
        };
        assert!(forgot.validate().is_ok());
    }
}
