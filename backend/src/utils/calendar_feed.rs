//! Secret token for the subscribable iCal calendar feed. The token is the sole
//! credential in the (otherwise unauthenticated) feed URL, so it is generated
//! from the OS CSPRNG and only ever stored as a SHA-256 hash — mirroring the
//! refresh-token handling in [`crate::utils::jwt`].

use rand::TryRng;
use sha2::{Digest, Sha256};

/// 32 random bytes rendered as 64 lowercase hex characters.
pub fn generate_feed_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rngs::SysRng
        .try_fill_bytes(&mut bytes)
        .expect("OS RNG unavailable while generating a calendar feed token");
    hex::encode(bytes)
}

/// Shape check before any lookup: exactly 64 lowercase-or-uppercase hex chars.
pub fn is_valid_feed_token(token: &str) -> bool {
    token.len() == 64 && token.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// SHA-256 hex of the token — what is stored and looked up. The token is
/// high-entropy, so a fast hash is appropriate (as with refresh tokens).
pub fn hash_feed_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    hex::encode(hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_tokens_are_64_hex_and_unique() {
        let a = generate_feed_token();
        let b = generate_feed_token();
        assert_eq!(a.len(), 64);
        assert!(is_valid_feed_token(&a));
        assert_ne!(a, b);
    }

    #[test]
    fn shape_check_rejects_bad_tokens() {
        assert!(!is_valid_feed_token(&"a".repeat(63)));
        assert!(!is_valid_feed_token(&"a".repeat(65)));
        assert!(!is_valid_feed_token(&"z".repeat(64)));
        assert!(!is_valid_feed_token(""));
    }

    #[test]
    fn hash_is_deterministic_sha256_hex() {
        assert_eq!(
            hash_feed_token("test"),
            "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
        );
        assert_eq!(hash_feed_token("a").len(), 64);
    }
}
