//! Wire types for end-to-end encryption key material.
//!
//! Everything here is opaque to the server. Public keys are validated for shape
//! and length so a malformed directory entry cannot be published, but their
//! meaning — and every private counterpart — belongs to the clients.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use validator::{Validate, ValidationError};

/// Raw byte length of an X25519 or Ed25519 public key.
pub const PUBLIC_KEY_BYTES: usize = 32;
/// Argon2id floors, mirrored from the database constraint. A client may ask for
/// more, never less; a weak KDF here would make the encrypted backup openable by
/// anyone who took a copy of the table.
pub const MIN_KDF_MEMORY_KIB: i32 = 19_456;
pub const MIN_KDF_ITERATIONS: i32 = 2;

/// Hex rather than base64, matching how this codebase already puts bytes on the
/// wire (refresh tokens, the TOTP key). Twice the characters, but these payloads
/// are a few kilobytes at most, and one encoding across the project is worth
/// more than the saving — a client that guesses wrong produces a key that
/// decodes to the wrong bytes rather than an obvious error.
fn decode_hex(value: &str) -> Result<Vec<u8>, ValidationError> {
    hex::decode(value).map_err(|_| ValidationError::new("invalid_hex"))
}

fn validate_public_key(value: &str) -> Result<(), ValidationError> {
    let decoded = decode_hex(value)?;
    if decoded.len() != PUBLIC_KEY_BYTES {
        let mut error = ValidationError::new("invalid_public_key_length");
        error.message = Some(format!("Public keys must be {PUBLIC_KEY_BYTES} bytes").into());
        return Err(error);
    }
    // An all-zero X25519 key is the canonical small-order point: agreement with
    // it yields a predictable shared secret, so refusing it here keeps a client
    // from publishing one by accident or on purpose.
    if decoded.iter().all(|byte| *byte == 0) {
        return Err(ValidationError::new("degenerate_public_key"));
    }
    Ok(())
}

fn validate_wrapped_key(value: &str) -> Result<(), ValidationError> {
    let decoded = decode_hex(value)?;
    if !(32..=4096).contains(&decoded.len()) {
        return Err(ValidationError::new("invalid_wrapped_key_length"));
    }
    Ok(())
}

/// Lowercase hex, exactly the shape the database CHECK enforces, so a value
/// that passes here cannot fail on insert.
fn validate_fingerprint(value: &str) -> Result<(), ValidationError> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(ValidationError::new("invalid_fingerprint"));
    }
    if value.bytes().any(|byte| byte.is_ascii_uppercase()) {
        return Err(ValidationError::new("fingerprint_must_be_lowercase"));
    }
    Ok(())
}

fn validate_salt(value: &str) -> Result<(), ValidationError> {
    let decoded = decode_hex(value)?;
    if decoded.len() != 16 {
        return Err(ValidationError::new("invalid_salt_length"));
    }
    Ok(())
}

/// The Argon2id parameters a backup was wrapped with.
///
/// Recorded rather than assumed: raising the default later must not make
/// existing backups unopenable, and a client has no other way to know what to
/// reproduce.
#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct KdfParameters {
    pub memory_kib: i32,
    pub iterations: i32,
    pub parallelism: i32,
}

impl KdfParameters {
    pub fn validate_cost(&self) -> Result<(), ValidationError> {
        if self.memory_kib < MIN_KDF_MEMORY_KIB
            || self.iterations < MIN_KDF_ITERATIONS
            || !(1..=4).contains(&self.parallelism)
        {
            let mut error = ValidationError::new("weak_kdf_parameters");
            error.message = Some(
                format!(
                    "Argon2id must use at least {MIN_KDF_MEMORY_KIB} KiB and \
                     {MIN_KDF_ITERATIONS} iterations"
                )
                .into(),
            );
            return Err(error);
        }
        // An upper bound too: a client asking for gigabytes would make its own
        // sign-in unusable, and the server would happily store the request.
        if self.memory_kib > 1_048_576 || self.iterations > 32 {
            return Err(ValidationError::new("excessive_kdf_parameters"));
        }
        Ok(())
    }
}

#[derive(Debug, Deserialize, Validate)]
#[serde(deny_unknown_fields)]
pub struct PublishKeysRequest {
    #[validate(custom(function = "validate_public_key"))]
    pub exchange_public_key: String,
    #[validate(custom(function = "validate_public_key"))]
    pub signing_public_key: String,
    /// Derived by the client from both public keys and shown to both parties as
    /// a safety number. The server stores it but cannot vouch for it; comparing
    /// it out of band is what makes a substituted directory entry detectable.
    #[validate(custom(function = "validate_fingerprint"))]
    pub key_fingerprint: String,

    #[validate(custom(function = "validate_wrapped_key"))]
    pub password_wrapped_key: String,
    #[validate(custom(function = "validate_salt"))]
    pub password_kdf_salt: String,
    pub password_kdf: KdfParameters,

    #[validate(custom(function = "validate_wrapped_key"))]
    pub recovery_wrapped_key: String,
    #[validate(custom(function = "validate_salt"))]
    pub recovery_kdf_salt: String,
}

/// A peer's public keys, as served to somebody about to message them.
#[derive(Debug, Serialize)]
pub struct PublicKeysResponse {
    pub user_id: Uuid,
    pub username: String,
    pub exchange_public_key: String,
    pub signing_public_key: String,
    pub key_fingerprint: String,
    pub generation: i32,
    pub updated_at: DateTime<Utc>,
}

/// The caller's own encrypted backup, returned so a new device can restore.
/// Opaque: the server holds ciphertext and the parameters needed to reproduce
/// the wrapping key, never the key itself.
#[derive(Debug, Serialize)]
pub struct KeyBackupResponse {
    pub password_wrapped_key: String,
    pub password_kdf_salt: String,
    pub password_kdf: KdfParameters,
    pub recovery_wrapped_key: String,
    pub recovery_kdf_salt: String,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct KeyStatusResponse {
    /// Whether this account has published keys at all. Clients use it to decide
    /// between first-time setup and restoring an existing backup.
    pub has_keys: bool,
    pub key_fingerprint: Option<String>,
    pub generation: Option<i32>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encode(bytes: &[u8]) -> String {
        hex::encode(bytes)
    }

    #[test]
    fn public_keys_must_be_exactly_thirty_two_bytes() {
        assert!(validate_public_key(&encode(&[7u8; 32])).is_ok());
        assert!(validate_public_key(&encode(&[7u8; 31])).is_err());
        assert!(validate_public_key(&encode(&[7u8; 33])).is_err());
        assert!(validate_public_key("not hex!").is_err());
    }

    #[test]
    fn an_all_zero_public_key_is_refused() {
        // The canonical small-order X25519 point: agreement against it produces
        // a predictable shared secret, so a peer publishing one could read what
        // was "encrypted" to them by anyone who did not check.
        assert!(validate_public_key(&encode(&[0u8; 32])).is_err());
    }

    #[test]
    fn fingerprints_must_be_lowercase_hex_of_the_right_length() {
        assert!(validate_fingerprint(&"a".repeat(64)).is_ok());
        assert!(validate_fingerprint(&"a".repeat(63)).is_err());
        assert!(validate_fingerprint(&"a".repeat(65)).is_err());
        assert!(validate_fingerprint(&"z".repeat(64)).is_err());
        // Uppercase would pass a naive hex check but fail the database CHECK,
        // turning a validation problem into a 500 at insert time.
        assert!(validate_fingerprint(&"A".repeat(64)).is_err());
    }

    #[test]
    fn wrapped_keys_are_bounded() {
        assert!(validate_wrapped_key(&encode(&[1u8; 64])).is_ok());
        // Too small to be a real wrapped key pair.
        assert!(validate_wrapped_key(&encode(&[1u8; 16])).is_err());
        // The ceiling stops this becoming free storage.
        assert!(validate_wrapped_key(&encode(&vec![1u8; 4097])).is_err());
    }

    #[test]
    fn salts_are_fixed_length() {
        assert!(validate_salt(&encode(&[2u8; 16])).is_ok());
        assert!(validate_salt(&encode(&[2u8; 8])).is_err());
    }

    #[test]
    fn kdf_parameters_below_the_floor_are_refused() {
        // The floor is what keeps a stolen copy of the backup table expensive to
        // attack. A client that asks for less is refused rather than trusted.
        let weak = KdfParameters {
            memory_kib: 1024,
            iterations: 1,
            parallelism: 1,
        };
        assert!(weak.validate_cost().is_err());

        let sound = KdfParameters {
            memory_kib: MIN_KDF_MEMORY_KIB,
            iterations: MIN_KDF_ITERATIONS,
            parallelism: 1,
        };
        assert!(sound.validate_cost().is_ok());
    }

    #[test]
    fn absurd_kdf_parameters_are_also_refused() {
        // Not a security floor but a usability one: a client asking for a
        // gigabyte would lock itself out of its own sign-in, and the server
        // would have stored the request.
        let absurd = KdfParameters {
            memory_kib: 8_388_608,
            iterations: 2,
            parallelism: 1,
        };
        assert!(absurd.validate_cost().is_err());
    }

    #[test]
    fn a_stronger_than_required_cost_is_allowed() {
        // The floor is a minimum, not a fixed value: a client must be able to
        // raise its own cost without a server change.
        let strong = KdfParameters {
            memory_kib: 65_536,
            iterations: 4,
            parallelism: 2,
        };
        assert!(strong.validate_cost().is_ok());
    }
}
