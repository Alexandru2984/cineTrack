use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::errors::AppError;

pub const MAX_REPORTS_PER_24_HOURS: i64 = 20;
pub const MAX_BLOCKS_PER_USER: i64 = 5_000;

pub async fn interaction_is_blocked(
    pool: &PgPool,
    first_user_id: Uuid,
    second_user_id: Uuid,
) -> Result<bool, AppError> {
    Ok(sqlx::query_scalar::<_, bool>(
        r#"SELECT EXISTS(
            SELECT 1
            FROM user_blocks block
            WHERE
                (block.blocker_id = $1 AND block.blocked_id = $2)
                OR
                (block.blocker_id = $2 AND block.blocked_id = $1)
        )"#,
    )
    .bind(first_user_id)
    .bind(second_user_id)
    .fetch_one(pool)
    .await?)
}

pub async fn interaction_is_blocked_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    first_user_id: Uuid,
    second_user_id: Uuid,
) -> Result<bool, AppError> {
    Ok(sqlx::query_scalar::<_, bool>(
        r#"SELECT EXISTS(
            SELECT 1
            FROM user_blocks block
            WHERE
                (block.blocker_id = $1 AND block.blocked_id = $2)
                OR
                (block.blocker_id = $2 AND block.blocked_id = $1)
        )"#,
    )
    .bind(first_user_id)
    .bind(second_user_id)
    .fetch_one(&mut **tx)
    .await?)
}
