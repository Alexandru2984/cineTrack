use chrono::{Duration, Utc};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::errors::AppError;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Claims {
    pub sub: Uuid,
    pub exp: i64,
    pub iat: i64,
}

pub fn generate_access_token(user_id: Uuid, secret: &str, expiry_hours: i64) -> Result<String, AppError> {
    let now = Utc::now();
    let claims = Claims {
        sub: user_id,
        iat: now.timestamp(),
        exp: (now + Duration::hours(expiry_hours)).timestamp(),
    };

    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|e| AppError::Unauthorized(format!("Failed to generate token: {}", e)))
}

pub fn validate_token(token: &str, secret: &str) -> Result<Claims, AppError> {
    let token_data = decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &Validation::default(),
    )?;
    Ok(token_data.claims)
}

pub fn generate_refresh_token() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let bytes: Vec<u8> = (0..64).map(|_| rng.gen()).collect();
    hex::encode(bytes)
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
        let token = generate_access_token(user_id, "test_secret_key_long_enough", 1).unwrap();
        assert!(!token.is_empty());
        // Should be a valid JWT (three dot-separated parts)
        assert_eq!(token.split('.').count(), 3);
    }

    #[test]
    fn test_validate_token_accepts_valid() {
        let user_id = Uuid::new_v4();
        let secret = "test_secret_key_long_enough";
        let token = generate_access_token(user_id, secret, 1).unwrap();
        let claims = validate_token(&token, secret).unwrap();
        assert_eq!(claims.sub, user_id);
    }

    #[test]
    fn test_validate_token_rejects_wrong_secret() {
        let user_id = Uuid::new_v4();
        let token = generate_access_token(user_id, "secret_one", 1).unwrap();
        let result = validate_token(&token, "secret_two");
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_token_rejects_expired() {
        let user_id = Uuid::new_v4();
        let secret = "test_secret";
        // Create a token that expired 1 hour ago
        let token = generate_access_token(user_id, secret, -1).unwrap();
        let result = validate_token(&token, secret);
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_token_rejects_garbage() {
        let result = validate_token("not.a.jwt", "secret");
        assert!(result.is_err());
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
    fn test_token_claims_contain_correct_timestamps() {
        let user_id = Uuid::new_v4();
        let secret = "test_secret";
        let token = generate_access_token(user_id, secret, 2).unwrap();
        let claims = validate_token(&token, secret).unwrap();
        assert!(claims.iat > 0);
        assert!(claims.exp > claims.iat);
        // Expiry should be ~2 hours from issued
        let diff = claims.exp - claims.iat;
        assert!((7100..=7300).contains(&diff)); // ~7200 seconds = 2 hours
    }
}
