use validator::ValidationError;

pub fn validate_username(username: &str) -> Result<(), ValidationError> {
    let bytes = username.as_bytes();
    let starts_and_ends_safely = bytes
        .first()
        .zip(bytes.last())
        .is_some_and(|(first, last)| first.is_ascii_alphanumeric() && last.is_ascii_alphanumeric());
    let contains_only_safe_characters = bytes
        .iter()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(*byte, b'_' | b'-'));

    if starts_and_ends_safely && contains_only_safe_characters {
        return Ok(());
    }

    let mut error = ValidationError::new("invalid_username");
    error.message = Some(
        "Username may contain letters, numbers, underscores, and hyphens, and must start and end with a letter or number"
            .into(),
    );
    Err(error)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_url_safe_usernames() {
        for username in ["abc", "Cinephile42", "film_buff", "film-buff"] {
            assert!(validate_username(username).is_ok(), "rejected {username}");
        }
    }

    #[test]
    fn rejects_ambiguous_or_path_unsafe_usernames() {
        for username in [
            "has space",
            "../admin",
            "user/name",
            "_leading",
            "trailing-",
            "control\nchar",
            "cinefilé",
        ] {
            assert!(
                validate_username(username).is_err(),
                "accepted {username:?}"
            );
        }
    }
}
