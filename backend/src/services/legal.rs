use sqlx::PgPool;
use uuid::Uuid;

use crate::errors::AppError;
use crate::models::User;

pub const CURRENT_TERMS_VERSION: &str = "2026-08-06";

/// Minimum age for an account. Chosen as the highest consent age GDPR Art. 8
/// lets a member state set, so one threshold covers the whole EEA without
/// per-country logic. Romania sets 16. Keep the Terms, the sign-up attestation
/// and the Play Console target-audience declaration on this same number.
pub const MINIMUM_AGE_YEARS: u8 = 16;

pub async fn accept_current_terms(pool: &PgPool, user_id: Uuid) -> Result<User, AppError> {
    let mut tx = pool.begin().await?;

    sqlx::query(
        r#"INSERT INTO user_terms_acceptances (user_id, terms_version)
        VALUES ($1, $2)
        ON CONFLICT (user_id, terms_version) DO NOTHING"#,
    )
    .bind(user_id)
    .bind(CURRENT_TERMS_VERSION)
    .execute(&mut *tx)
    .await?;

    let user = sqlx::query_as::<_, User>(
        r#"UPDATE users
        SET terms_accepted_version = $2,
            terms_accepted_at = COALESCE(
                (
                    SELECT accepted_at
                    FROM user_terms_acceptances
                    WHERE user_id = $1 AND terms_version = $2
                ),
                NOW()
            ),
            updated_at = NOW()
        WHERE id = $1
        RETURNING *"#,
    )
    .bind(user_id)
    .bind(CURRENT_TERMS_VERSION)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::Unauthorized("User not found".to_string()))?;

    tx.commit().await?;
    log::info!("audit: terms accepted user_id={user_id} version={CURRENT_TERMS_VERSION}");
    Ok(user)
}

pub async fn require_current_terms(pool: &PgPool, user_id: Uuid) -> Result<(), AppError> {
    let accepted_version = sqlx::query_scalar::<_, Option<String>>(
        "SELECT terms_accepted_version FROM users WHERE id = $1",
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await?
    .flatten();

    if accepted_version.as_deref() != Some(CURRENT_TERMS_VERSION) {
        return Err(AppError::Forbidden(
            "Accept the current Terms of Use and Community Guidelines to use community features"
                .to_string(),
        ));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terms_version_is_date_versioned() {
        let parts: Vec<_> = CURRENT_TERMS_VERSION.split('-').collect();
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0].len(), 4);
        assert_eq!(parts[1].len(), 2);
        assert_eq!(parts[2].len(), 2);
    }
}
