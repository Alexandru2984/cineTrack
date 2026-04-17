use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};

use crate::errors::AppError;

pub fn hash_password(password: &str) -> Result<String, AppError> {
    let salt = SaltString::generate(&mut OsRng);
    let argon2 = Argon2::default();
    let hash = argon2
        .hash_password(password.as_bytes(), &salt)
        .map_err(|e| AppError::BadRequest(format!("Failed to hash password: {}", e)))?;
    Ok(hash.to_string())
}

pub fn verify_password(password: &str, hash: &str) -> Result<bool, AppError> {
    let parsed_hash = PasswordHash::new(hash)
        .map_err(|e| AppError::BadRequest(format!("Invalid password hash: {}", e)))?;
    Ok(Argon2::default()
        .verify_password(password.as_bytes(), &parsed_hash)
        .is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_hash_password_produces_argon2_hash() {
        let hash = hash_password("TestPass123").unwrap();
        assert!(hash.starts_with("$argon2"));
    }

    #[test]
    fn test_verify_password_correct() {
        let hash = hash_password("MyPassword1").unwrap();
        assert!(verify_password("MyPassword1", &hash).unwrap());
    }

    #[test]
    fn test_verify_password_wrong() {
        let hash = hash_password("MyPassword1").unwrap();
        assert!(!verify_password("WrongPassword1", &hash).unwrap());
    }

    #[test]
    fn test_hash_password_unique_salts() {
        let h1 = hash_password("SamePassword1").unwrap();
        let h2 = hash_password("SamePassword1").unwrap();
        // Different salts → different hashes
        assert_ne!(h1, h2);
        // But both verify correctly
        assert!(verify_password("SamePassword1", &h1).unwrap());
        assert!(verify_password("SamePassword1", &h2).unwrap());
    }

    #[test]
    fn test_verify_password_rejects_invalid_hash() {
        let result = verify_password("test", "not_a_valid_hash");
        assert!(result.is_err());
    }
}
