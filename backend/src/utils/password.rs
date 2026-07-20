use std::time::Duration;

use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, Salt, SaltString},
    Argon2,
};
use rand::TryRng;
use tokio::sync::{OnceCell, Semaphore};

use crate::errors::AppError;

const MAX_CONCURRENT_PASSWORD_JOBS: usize = 4;
const PASSWORD_QUEUE_TIMEOUT: Duration = Duration::from_secs(2);
const DUMMY_PASSWORD: &str = "cinetrack-dummy-password-never-used-for-login";

static PASSWORD_JOB_SLOTS: Semaphore = Semaphore::const_new(MAX_CONCURRENT_PASSWORD_JOBS);
static DUMMY_PASSWORD_HASH: OnceCell<String> = OnceCell::const_new();

/// Build the salt from our own RNG rather than password_hash's re-exported
/// `OsRng`. That re-export only exists when some crate in the graph happens to
/// turn on `rand_core/getrandom`, which made password hashing fail to compile
/// the moment an unrelated dependency stopped enabling it. This uses the same
/// system RNG the rest of the security code already uses and is already tested.
fn generate_salt() -> Result<SaltString, AppError> {
    let mut bytes = [0u8; Salt::RECOMMENDED_LENGTH];
    rand::rngs::SysRng
        .try_fill_bytes(&mut bytes)
        .map_err(|error| {
            AppError::InternalError(anyhow::anyhow!(
                "OS RNG unavailable for a password salt: {error}"
            ))
        })?;
    SaltString::encode_b64(&bytes)
        .map_err(|error| AppError::InternalError(anyhow::anyhow!("salt encoding failed: {error}")))
}

fn hash_password_sync(password: &str) -> Result<String, AppError> {
    let salt = generate_salt()?;
    let argon2 = Argon2::default();
    let hash = argon2
        .hash_password(password.as_bytes(), &salt)
        .map_err(|error| {
            AppError::InternalError(anyhow::anyhow!("password hashing failed: {error}"))
        })?;
    Ok(hash.to_string())
}

fn verify_password_sync(password: &str, hash: &str) -> Result<bool, AppError> {
    let parsed_hash = PasswordHash::new(hash).map_err(|error| {
        AppError::InternalError(anyhow::anyhow!("stored password hash is invalid: {error}"))
    })?;
    Ok(Argon2::default()
        .verify_password(password.as_bytes(), &parsed_hash)
        .is_ok())
}

async fn run_password_job<T, F>(job: F) -> Result<T, AppError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, AppError> + Send + 'static,
{
    let _permit = tokio::time::timeout(PASSWORD_QUEUE_TIMEOUT, PASSWORD_JOB_SLOTS.acquire())
        .await
        .map_err(|_| {
            AppError::TooManyRequests("Authentication service is busy; retry shortly".to_string())
        })?
        .map_err(|_| {
            AppError::InternalError(anyhow::anyhow!("password work queue is unavailable"))
        })?;

    tokio::task::spawn_blocking(job).await.map_err(|error| {
        AppError::InternalError(anyhow::anyhow!("password worker failed: {error}"))
    })?
}

pub async fn hash_password(password: &str) -> Result<String, AppError> {
    let password = password.to_owned();
    run_password_job(move || hash_password_sync(&password)).await
}

pub async fn verify_password(password: &str, hash: &str) -> Result<bool, AppError> {
    let password = password.to_owned();
    let hash = hash.to_owned();
    run_password_job(move || verify_password_sync(&password, &hash)).await
}

async fn dummy_password_hash() -> Result<&'static str, AppError> {
    let hash = DUMMY_PASSWORD_HASH
        .get_or_try_init(|| async { hash_password(DUMMY_PASSWORD).await })
        .await?;
    Ok(hash.as_str())
}

pub async fn initialize() -> Result<(), AppError> {
    dummy_password_hash().await.map(|_| ())
}

pub async fn verify_password_or_dummy(
    password: &str,
    stored_hash: Option<&str>,
) -> Result<bool, AppError> {
    let has_password_login = stored_hash.is_some();
    let hash = match stored_hash {
        Some(hash) => hash,
        None => dummy_password_hash().await?,
    };

    let matches = verify_password(password, hash).await?;
    Ok(has_password_login && matches)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_salts_are_unique_and_recommended_width() {
        // Guards the RNG wiring: a constant or short salt would still hash and
        // verify happily, so nothing else in this file would notice.
        let first = generate_salt().expect("salt");
        let second = generate_salt().expect("salt");
        assert_ne!(first.as_str(), second.as_str());
        // 16 bytes of B64 without padding.
        assert_eq!(first.len(), 22);
    }

    #[tokio::test]
    async fn verifies_a_hash_whose_salt_this_code_did_not_generate() {
        // Every stored hash in production was salted by the previous code path.
        // Verification reads the salt out of the encoded string, so changing how
        // salts are produced must not invalidate them — this builds a hash from
        // a fixed salt, bypassing generate_salt entirely, and requires it to
        // still authenticate.
        use argon2::password_hash::{PasswordHasher, SaltString};
        let salt = SaltString::from_b64("YWJjZGVmZ2hpamtsbW5vcA").expect("fixed salt");
        let legacy = Argon2::default()
            .hash_password(b"Passw0rd123!", &salt)
            .expect("hash with a fixed salt")
            .to_string();

        assert!(verify_password("Passw0rd123!", &legacy)
            .await
            .expect("verify"));
        assert!(!verify_password("Wr0ngPassword!", &legacy)
            .await
            .expect("verify"));
    }

    #[tokio::test]
    async fn hashes_from_the_generated_salt_verify_and_differ() {
        let one = hash_password("Passw0rd123!").await.expect("hash");
        let two = hash_password("Passw0rd123!").await.expect("hash");
        // Same password, different salt, therefore different stored value.
        assert_ne!(one, two);
        assert!(verify_password("Passw0rd123!", &one).await.expect("verify"));
        assert!(!verify_password("Wr0ngPassword!", &one)
            .await
            .expect("verify"));
    }

    #[tokio::test]
    async fn test_hash_password_produces_argon2_hash() {
        let hash = hash_password("TestPass123").await.unwrap();
        assert!(hash.starts_with("$argon2"));
    }

    #[tokio::test]
    async fn test_verify_password_correct() {
        let hash = hash_password("MyPassword1").await.unwrap();
        assert!(verify_password("MyPassword1", &hash).await.unwrap());
    }

    #[tokio::test]
    async fn test_verify_password_wrong() {
        let hash = hash_password("MyPassword1").await.unwrap();
        assert!(!verify_password("WrongPassword1", &hash).await.unwrap());
    }

    #[tokio::test]
    async fn test_hash_password_unique_salts() {
        let h1 = hash_password("SamePassword1").await.unwrap();
        let h2 = hash_password("SamePassword1").await.unwrap();
        // Different salts → different hashes
        assert_ne!(h1, h2);
        // But both verify correctly
        assert!(verify_password("SamePassword1", &h1).await.unwrap());
        assert!(verify_password("SamePassword1", &h2).await.unwrap());
    }

    #[tokio::test]
    async fn test_verify_password_rejects_invalid_hash() {
        let result = verify_password("test", "not_a_valid_hash").await;
        assert!(matches!(result, Err(AppError::InternalError(_))));
    }

    #[tokio::test]
    async fn test_dummy_verification_never_authenticates() {
        initialize().await.unwrap();

        assert!(!verify_password_or_dummy(DUMMY_PASSWORD, None)
            .await
            .unwrap());
    }
}
