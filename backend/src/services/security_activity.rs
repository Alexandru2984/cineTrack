use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::{PgConnection, PgPool};
use uuid::Uuid;

use crate::errors::AppError;

const MAX_EVENTS_PER_USER: i64 = 200;
const API_EVENT_LIMIT: i64 = 100;

#[derive(Debug, Clone, Copy)]
pub enum SecurityActivityKind {
    AccountRegistered,
    LoginSucceeded,
    PasswordChanged,
    PasswordReset,
    EmailChangeRequested,
    EmailChanged,
    TwoFactorEnabled,
    TwoFactorDisabled,
    SessionRevoked,
    AllSessionsRevoked,
    AccountDataExported,
}

impl SecurityActivityKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::AccountRegistered => "account_registered",
            Self::LoginSucceeded => "login_succeeded",
            Self::PasswordChanged => "password_changed",
            Self::PasswordReset => "password_reset",
            Self::EmailChangeRequested => "email_change_requested",
            Self::EmailChanged => "email_changed",
            Self::TwoFactorEnabled => "two_factor_enabled",
            Self::TwoFactorDisabled => "two_factor_disabled",
            Self::SessionRevoked => "session_revoked",
            Self::AllSessionsRevoked => "all_sessions_revoked",
            Self::AccountDataExported => "account_data_exported",
        }
    }
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct SecurityActivityResponse {
    pub id: Uuid,
    pub event_type: String,
    pub user_agent: Option<String>,
    pub ip_address: Option<String>,
    pub created_at: DateTime<Utc>,
}

/// Append one event inside the caller's transaction and enforce the per-user
/// cap before that transaction commits. There is intentionally no update path.
pub async fn record_in_transaction(
    connection: &mut PgConnection,
    user_id: Uuid,
    kind: SecurityActivityKind,
    user_agent: Option<&str>,
    ip_address: Option<&str>,
) -> Result<(), AppError> {
    // Serialize the insert-and-cap sequence per account. Without this lock two
    // concurrent successful logins could each observe 200 rows and leave 201.
    sqlx::query(
        "SELECT pg_advisory_xact_lock(
            hashtextextended('security-activity:' || $1::text, 0)
         )",
    )
    .bind(user_id)
    .execute(&mut *connection)
    .await?;

    sqlx::query(
        "INSERT INTO security_activity (user_id, event_type, user_agent, ip_address)
         VALUES ($1, $2, $3, $4)",
    )
    .bind(user_id)
    .bind(kind.as_str())
    .bind(user_agent)
    .bind(ip_address)
    .execute(&mut *connection)
    .await?;

    sqlx::query(
        "DELETE FROM security_activity
         WHERE user_id = $1
           AND id IN (
               SELECT id
               FROM security_activity
               WHERE user_id = $1
               ORDER BY created_at DESC, id DESC
               OFFSET $2
           )",
    )
    .bind(user_id)
    .bind(MAX_EVENTS_PER_USER)
    .execute(connection)
    .await?;

    Ok(())
}

pub async fn list_for_user(
    pool: &PgPool,
    user_id: Uuid,
) -> Result<Vec<SecurityActivityResponse>, AppError> {
    Ok(sqlx::query_as::<_, SecurityActivityResponse>(
        "SELECT id, event_type, user_agent, ip_address, created_at
         FROM security_activity
         WHERE user_id = $1
         ORDER BY created_at DESC, id DESC
         LIMIT $2",
    )
    .bind(user_id)
    .bind(API_EVENT_LIMIT)
    .fetch_all(pool)
    .await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_names_match_the_database_allowlist() {
        assert_eq!(
            [
                SecurityActivityKind::AccountRegistered,
                SecurityActivityKind::LoginSucceeded,
                SecurityActivityKind::PasswordChanged,
                SecurityActivityKind::PasswordReset,
                SecurityActivityKind::EmailChangeRequested,
                SecurityActivityKind::EmailChanged,
                SecurityActivityKind::TwoFactorEnabled,
                SecurityActivityKind::TwoFactorDisabled,
                SecurityActivityKind::SessionRevoked,
                SecurityActivityKind::AllSessionsRevoked,
                SecurityActivityKind::AccountDataExported,
            ]
            .map(SecurityActivityKind::as_str),
            [
                "account_registered",
                "login_succeeded",
                "password_changed",
                "password_reset",
                "email_change_requested",
                "email_changed",
                "two_factor_enabled",
                "two_factor_disabled",
                "session_revoked",
                "all_sessions_revoked",
                "account_data_exported",
            ]
        );
    }
}
