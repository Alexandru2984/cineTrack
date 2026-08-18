use chrono::{Duration, Utc};
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use rand::TryRng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::errors::AppError;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Claims {
    pub sub: Uuid,
    /// Session identity: the `family_id` of the refresh token this access token
    /// was minted alongside. Constant across rotation, so it names the sign-in
    /// rather than the individual token, which is what revocation needs to
    /// address. See `services::revocation`.
    pub sid: Uuid,
    pub exp: i64,
    pub iat: i64,
}

pub fn generate_access_token(
    user_id: Uuid,
    session_id: Uuid,
    secret: &str,
    expiry_minutes: i64,
) -> Result<String, AppError> {
    let now = Utc::now();
    let claims = Claims {
        sub: user_id,
        sid: session_id,
        iat: now.timestamp(),
        exp: (now + Duration::minutes(expiry_minutes)).timestamp(),
    };

    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|_| AppError::InternalError(anyhow::anyhow!("Failed to generate access token")))
}

pub fn validate_token(token: &str, secret: &str) -> Result<Claims, AppError> {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.validate_exp = true;
    validation.leeway = 5;
    // Only registered claims can be listed here; `sid` is a private claim and
    // is enforced instead by `Claims::sid` being a plain `Uuid` rather than an
    // `Option`, so a token without it fails to deserialize and is rejected.
    //
    // That is deliberate. Tokens minted before this claim existed stop
    // validating at deploy, because the alternative — treating an absent `sid`
    // as "not revocable, therefore allowed" — reopens the exact hole the claim
    // closes, to anyone who simply strips it. The cost is one 401 per in-flight
    // token, indistinguishable from an expired one, which both the web and
    // mobile clients already answer by refreshing and retrying.
    validation.set_required_spec_claims(&["exp", "sub"]);

    let token_data = decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    )?;
    Ok(token_data.claims)
}

pub fn generate_refresh_token() -> String {
    let mut bytes = [0u8; 64];
    rand::rngs::SysRng
        .try_fill_bytes(&mut bytes)
        .expect("OS RNG unavailable while generating a refresh token");
    hex::encode(bytes)
}

pub fn is_valid_refresh_token(token: &str) -> bool {
    token.len() == 128 && token.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// SHA-256 hash for refresh token storage (fast, secure for high-entropy tokens)
pub fn hash_refresh_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    hex::encode(hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_access_token_valid() {
        let user_id = Uuid::new_v4();
        let token =
            generate_access_token(user_id, Uuid::new_v4(), "test_secret_key_long_enough", 15)
                .unwrap();
        assert!(!token.is_empty());
        // Should be a valid JWT (three dot-separated parts)
        assert_eq!(token.split('.').count(), 3);
    }

    #[test]
    fn test_validate_token_accepts_valid() {
        let user_id = Uuid::new_v4();
        let secret = "test_secret_key_long_enough";
        let session_id = Uuid::new_v4();
        let token = generate_access_token(user_id, session_id, secret, 15).unwrap();
        let claims = validate_token(&token, secret).unwrap();
        assert_eq!(claims.sub, user_id);
        assert_eq!(claims.sid, session_id);
    }

    #[test]
    fn test_validate_token_rejects_wrong_secret() {
        let user_id = Uuid::new_v4();
        let token = generate_access_token(user_id, Uuid::new_v4(), "secret_one", 15).unwrap();
        let result = validate_token(&token, "secret_two");
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_token_rejects_expired() {
        let user_id = Uuid::new_v4();
        let secret = "test_secret";
        // Create a token that expired one minute ago.
        let token = generate_access_token(user_id, Uuid::new_v4(), secret, -1).unwrap();
        let result = validate_token(&token, secret);
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_token_rejects_garbage() {
        let result = validate_token("not.a.jwt", "secret");
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_token_rejects_malformed_exp_type() {
        let secret = "test_secret_key_long_enough";
        let claims = serde_json::json!({
            "sub": Uuid::new_v4(),
            "sid": Uuid::new_v4(),
            "iat": Utc::now().timestamp(),
            "exp": "never"
        });
        let token = encode(
            &Header::default(),
            &claims,
            &EncodingKey::from_secret(secret.as_bytes()),
        )
        .unwrap();

        assert!(validate_token(&token, secret).is_err());
    }

    #[test]
    fn test_validate_token_rejects_a_missing_session_claim() {
        // The revocation check is keyed on `sid`. A token without one cannot be
        // revoked, so accepting it would hand anyone who strips the claim a
        // credential that survives "sign out everywhere". Correctly signed and
        // unexpired is not enough.
        let secret = "test_secret_key_long_enough";
        let claims = serde_json::json!({
            "sub": Uuid::new_v4(),
            "iat": Utc::now().timestamp(),
            "exp": (Utc::now() + Duration::minutes(15)).timestamp(),
        });
        let token = encode(
            &Header::default(),
            &claims,
            &EncodingKey::from_secret(secret.as_bytes()),
        )
        .unwrap();

        assert!(validate_token(&token, secret).is_err());
    }

    #[test]
    fn test_validate_token_rejects_a_malformed_session_claim() {
        let secret = "test_secret_key_long_enough";
        let claims = serde_json::json!({
            "sub": Uuid::new_v4(),
            "sid": "not-a-uuid",
            "iat": Utc::now().timestamp(),
            "exp": (Utc::now() + Duration::minutes(15)).timestamp(),
        });
        let token = encode(
            &Header::default(),
            &claims,
            &EncodingKey::from_secret(secret.as_bytes()),
        )
        .unwrap();

        assert!(validate_token(&token, secret).is_err());
    }

    #[test]
    fn test_two_sessions_for_one_user_get_distinct_session_claims() {
        // Revocation addresses sessions, so two sign-ins by the same account
        // must be distinguishable — otherwise revoking one would revoke both.
        let user_id = Uuid::new_v4();
        let secret = "test_secret_key_long_enough";
        let first = validate_token(
            &generate_access_token(user_id, Uuid::new_v4(), secret, 15).unwrap(),
            secret,
        )
        .unwrap();
        let second = validate_token(
            &generate_access_token(user_id, Uuid::new_v4(), secret, 15).unwrap(),
            secret,
        )
        .unwrap();

        assert_eq!(first.sub, second.sub);
        assert_ne!(first.sid, second.sid);
    }

    #[test]
    fn test_generate_refresh_token_length() {
        let token = generate_refresh_token();
        // 64 random bytes → 128 hex chars
        assert_eq!(token.len(), 128);
    }

    #[test]
    fn test_generate_refresh_token_unique() {
        let t1 = generate_refresh_token();
        let t2 = generate_refresh_token();
        assert_ne!(t1, t2);
    }

    #[test]
    fn test_generate_refresh_token_is_hex() {
        let token = generate_refresh_token();
        assert!(token.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(is_valid_refresh_token(&token));
    }

    #[test]
    fn test_refresh_token_shape_rejects_bad_input() {
        assert!(!is_valid_refresh_token(&"a".repeat(127)));
        assert!(!is_valid_refresh_token(&"a".repeat(129)));
        assert!(!is_valid_refresh_token(&"z".repeat(128)));
    }

    #[test]
    fn test_hash_refresh_token_deterministic() {
        let token = "some_refresh_token_value";
        let h1 = hash_refresh_token(token);
        let h2 = hash_refresh_token(token);
        assert_eq!(h1, h2);
    }

    #[test]
    fn test_hash_refresh_token_different_inputs() {
        let h1 = hash_refresh_token("token_a");
        let h2 = hash_refresh_token("token_b");
        assert_ne!(h1, h2);
    }

    #[test]
    fn test_hash_refresh_token_is_sha256_hex() {
        let hash = hash_refresh_token("test");
        // SHA-256 → 64 hex chars
        assert_eq!(hash.len(), 64);
        assert!(hash.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn test_hash_refresh_token_matches_known_sha256() {
        // Known-answer test against the canonical SHA-256 of "test". These hashes
        // are what refresh_tokens.token_hash stores, so a digest change would log
        // every live session out; pin the value rather than only its shape.
        assert_eq!(
            hash_refresh_token("test"),
            "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
        );
    }

    #[test]
    fn test_token_claims_contain_correct_timestamps() {
        let user_id = Uuid::new_v4();
        let secret = "test_secret";
        let token = generate_access_token(user_id, Uuid::new_v4(), secret, 15).unwrap();
        let claims = validate_token(&token, secret).unwrap();
        assert!(claims.iat > 0);
        assert!(claims.exp > claims.iat);
        // Expiry should be exactly 15 minutes from issuance.
        let diff = claims.exp - claims.iat;
        assert_eq!(diff, 900);
    }
}
