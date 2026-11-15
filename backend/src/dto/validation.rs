use validator::ValidationError;

/// Names that read as the service or its staff, or that a fixed route already
/// answers (`/api/users/search`). A follow request or a message from `admin`
/// or `vazute` is a ready pretext, so no account may take one.
///
/// Compared after lowercasing and dropping `_` and `-`, so `Ad_Min` and
/// `no-reply` are caught too. No account held one of these when the list was
/// introduced (checked on production, 2026-11-15), so a profile update that
/// resends the current name cannot be refused by it.
const RESERVED_USERNAMES: &[&str] = &[
    "about",
    "abuse",
    "admin",
    "administrator",
    "anonymous",
    "api",
    "contact",
    "deleted",
    "dev",
    "developer",
    "everyone",
    "help",
    "helpdesk",
    "hostmaster",
    "info",
    "legal",
    "login",
    "logout",
    "mod",
    "moderation",
    "moderator",
    "mods",
    "noreply",
    "null",
    "official",
    "postmaster",
    "privacy",
    "register",
    "root",
    "search",
    "security",
    "settings",
    "signin",
    "signup",
    "staff",
    "support",
    "system",
    "team",
    "terms",
    "undefined",
    "webmaster",
];

/// The product's own names, refused anywhere in a username: `vazute_team` or
/// `cinetrack-support` would pass for the service as well as `vazute` does.
const RESERVED_NAME_PARTS: &[&str] = &["vazute", "cinetrack"];

fn is_reserved_username(username: &str) -> bool {
    let folded: String = username
        .chars()
        .filter(|ch| !matches!(ch, '_' | '-'))
        .map(|ch| ch.to_ascii_lowercase())
        .collect();
    RESERVED_USERNAMES.contains(&folded.as_str())
        || RESERVED_NAME_PARTS.iter().any(|part| folded.contains(part))
}

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
        if is_reserved_username(username) {
            let mut error = ValidationError::new("reserved_username");
            error.message = Some("That username is reserved".into());
            return Err(error);
        }
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
    fn refuses_staff_and_service_names_in_any_case_or_spelling() {
        for username in [
            "admin",
            "Admin",
            "ADMIN",
            "ad_min",
            "support",
            "Moderator",
            "vazute",
            "Vazute_Official",
            "the-vazute-team",
            "cinetrack",
            "no-reply",
            "search",
        ] {
            let error = validate_username(username).expect_err(username);
            assert_eq!(error.code, "reserved_username", "{username}");
        }
    }

    #[test]
    fn leaves_ordinary_names_that_merely_contain_a_reserved_word() {
        for username in [
            "admiral",
            "supporter",
            "moderate_fan",
            "searcher",
            "teamrocket",
            "rootbeer",
        ] {
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
