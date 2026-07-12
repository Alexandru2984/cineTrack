use sqlx::{Postgres, Transaction};
use uuid::Uuid;

use crate::errors::AppError;

pub const MAX_TRACKING_ITEMS_PER_USER: i64 = 10_000;
pub const MAX_HISTORY_EVENTS_PER_USER: i64 = 100_000;

pub async fn lock_and_count_tracking(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
) -> Result<i64, AppError> {
    lock_tracking_writes(tx, user_id).await?;

    Ok(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM user_media WHERE user_id = $1")
            .bind(user_id)
            .fetch_one(&mut **tx)
            .await?,
    )
}

pub async fn lock_tracking_writes(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
) -> Result<(), AppError> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended('tracking-quota:' || $1::text, 0))")
        .bind(user_id)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

pub async fn lock_and_count_history(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
) -> Result<i64, AppError> {
    lock_history_writes(tx, user_id).await?;

    Ok(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM watch_history WHERE user_id = $1")
            .bind(user_id)
            .fetch_one(&mut **tx)
            .await?,
    )
}

pub async fn lock_history_writes(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
) -> Result<(), AppError> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended('history-quota:' || $1::text, 0))")
        .bind(user_id)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

pub fn ensure_tracking_capacity(current: i64, additional: i64) -> Result<(), AppError> {
    ensure_capacity(
        current,
        additional,
        MAX_TRACKING_ITEMS_PER_USER,
        "tracked titles",
    )
}

pub fn ensure_history_capacity(current: i64, additional: i64) -> Result<(), AppError> {
    ensure_capacity(
        current,
        additional,
        MAX_HISTORY_EVENTS_PER_USER,
        "history events",
    )
}

fn ensure_capacity(
    current: i64,
    additional: i64,
    maximum: i64,
    resource: &str,
) -> Result<(), AppError> {
    let projected = current
        .checked_add(additional)
        .filter(|_| current >= 0 && additional >= 0)
        .ok_or_else(|| {
            AppError::InternalError(anyhow::anyhow!("invalid {resource} quota calculation"))
        })?;

    if projected > maximum {
        return Err(AppError::Conflict(format!(
            "An account can have at most {maximum} {resource}"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tracking_quota_allows_updates_but_not_new_rows_at_limit() {
        assert!(ensure_tracking_capacity(MAX_TRACKING_ITEMS_PER_USER, 0).is_ok());
        assert!(matches!(
            ensure_tracking_capacity(MAX_TRACKING_ITEMS_PER_USER, 1),
            Err(AppError::Conflict(_))
        ));
    }

    #[test]
    fn history_quota_rejects_batches_that_cross_limit() {
        assert!(ensure_history_capacity(MAX_HISTORY_EVENTS_PER_USER - 10, 10).is_ok());
        assert!(matches!(
            ensure_history_capacity(MAX_HISTORY_EVENTS_PER_USER - 10, 11),
            Err(AppError::Conflict(_))
        ));
    }

    #[test]
    fn quota_calculation_rejects_invalid_or_overflowing_counts() {
        assert!(matches!(
            ensure_history_capacity(-1, 0),
            Err(AppError::InternalError(_))
        ));
        assert!(matches!(
            ensure_history_capacity(i64::MAX, 1),
            Err(AppError::InternalError(_))
        ));
    }
}
