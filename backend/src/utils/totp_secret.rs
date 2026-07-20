//! Authenticated encryption for TOTP shared secrets stored in PostgreSQL.

use aes_gcm::{
    aead::{Aead, AeadCore, Generate, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use anyhow::{anyhow, Context};
use uuid::Uuid;

const FORMAT_VERSION: &str = "v1";

pub fn encrypt(key: &[u8; 32], user_id: Uuid, secret: &[u8]) -> anyhow::Result<String> {
    let cipher = Aes256Gcm::new_from_slice(key).expect("AES-256 key has fixed width");
    let nonce = Nonce::generate();
    let ciphertext = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: secret,
                aad: user_id.as_bytes(),
            },
        )
        .map_err(|_| anyhow!("TOTP secret encryption failed"))?;
    Ok(format!(
        "{FORMAT_VERSION}:{}:{}",
        hex::encode(nonce),
        hex::encode(ciphertext)
    ))
}

pub fn decrypt(key: &[u8; 32], user_id: Uuid, stored: &str) -> anyhow::Result<Vec<u8>> {
    let mut parts = stored.split(':');
    let version = parts.next();
    let nonce_hex = parts.next();
    let ciphertext_hex = parts.next();
    if version != Some(FORMAT_VERSION)
        || nonce_hex.is_none()
        || ciphertext_hex.is_none()
        || parts.next().is_some()
    {
        return Err(anyhow!("stored TOTP secret has an unsupported format"));
    }

    let nonce_bytes = hex::decode(nonce_hex.unwrap()).context("stored TOTP nonce is not hex")?;
    let nonce: Nonce<<Aes256Gcm as AeadCore>::NonceSize> = nonce_bytes
        .as_slice()
        .try_into()
        .map_err(|_| anyhow!("stored TOTP nonce has the wrong length"))?;
    let ciphertext =
        hex::decode(ciphertext_hex.unwrap()).context("stored TOTP ciphertext is not hex")?;
    let cipher = Aes256Gcm::new_from_slice(key).expect("AES-256 key has fixed width");
    cipher
        .decrypt(
            &nonce,
            Payload {
                msg: &ciphertext,
                aad: user_id.as_bytes(),
            },
        )
        .map_err(|_| anyhow!("stored TOTP secret authentication failed"))
}

pub fn is_encrypted(stored: &str) -> bool {
    stored.starts_with(&format!("{FORMAT_VERSION}:"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_uses_unique_nonces_and_user_bound_aad() {
        let key = [0x42; 32];
        let user = Uuid::new_v4();
        let secret = b"twenty-byte-secret!!";
        let first = encrypt(&key, user, secret).unwrap();
        let second = encrypt(&key, user, secret).unwrap();

        assert_ne!(first, second);
        assert!(is_encrypted(&first));
        assert_eq!(decrypt(&key, user, &first).unwrap(), secret);
        assert!(decrypt(&key, Uuid::new_v4(), &first).is_err());
    }

    #[test]
    fn tampering_and_unknown_formats_fail_closed() {
        let key = [0x24; 32];
        let user = Uuid::new_v4();
        let encrypted = encrypt(&key, user, b"secret").unwrap();
        let mut tampered = encrypted.into_bytes();
        let last = tampered.len() - 1;
        tampered[last] = if tampered[last] == b'0' { b'1' } else { b'0' };

        assert!(decrypt(&key, user, std::str::from_utf8(&tampered).unwrap()).is_err());
        assert!(decrypt(&key, user, "plaintext").is_err());
    }
}
