use std::time::Duration;

use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use tokio::sync::{OnceCell, Semaphore};

use crate::errors::AppError;

const MAX_CONCURRENT_PASSWORD_JOBS: usize = 4;
const PASSWORD_QUEUE_TIMEOUT: Duration = Duration::from_secs(2);
const DUMMY_PASSWORD: &str = "cinetrack-dummy-password-never-used-for-login";

static PASSWORD_JOB_SLOTS: Semaphore = Semaphore::const_new(MAX_CONCURRENT_PASSWORD_JOBS);
static DUMMY_PASSWORD_HASH: OnceCell<String> = OnceCell::const_new();

fn hash_password_sync(password: &str) -> Result<String, AppError> {
    let salt = SaltString::generate(&mut OsRng);
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
