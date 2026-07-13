use sqlx::{Postgres, Transaction};
use uuid::Uuid;

use crate::errors::AppError;

pub const FOLLOW_REQUEST: &str = "follow_request";
pub const FOLLOW_ACCEPTED: &str = "follow_accepted";
pub const NEW_FOLLOWER: &str = "new_follower";

const MAX_NOTIFICATIONS_PER_USER: i64 = 5_000;

pub async fn upsert(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    actor_id: Uuid,
    kind: &'static str,
) -> Result<(), AppError> {
    sqlx::query(
        r#"INSERT INTO notifications (user_id, actor_id, kind)
        VALUES ($1, $2, $3)
        ON CONFLICT (user_id, actor_id, kind) DO UPDATE SET
            read_at = NULL,
            created_at = NOW()"#,
    )
    .bind(user_id)
    .bind(actor_id)
    .bind(kind)
    .execute(&mut **tx)
    .await?;

    prune_user(tx, user_id).await
}

pub async fn upsert_many(
    tx: &mut Transaction<'_, Postgres>,
    user_ids: &[Uuid],
    actor_id: Uuid,
    kind: &'static str,
) -> Result<(), AppError> {
    if user_ids.is_empty() {
        return Ok(());
    }

    sqlx::query(
        r#"INSERT INTO notifications (user_id, actor_id, kind)
        SELECT recipient_id, $2, $3
        FROM UNNEST($1::uuid[]) AS recipient(recipient_id)
        WHERE recipient_id <> $2
        ON CONFLICT (user_id, actor_id, kind) DO UPDATE SET
            read_at = NULL,
            created_at = NOW()"#,
    )
    .bind(user_ids)
    .bind(actor_id)
    .bind(kind)
    .execute(&mut **tx)
    .await?;

    sqlx::query(
        r#"WITH ranked AS (
            SELECT id, created_at,
                ROW_NUMBER() OVER (
                    PARTITION BY user_id ORDER BY created_at DESC, id DESC
                ) AS position
            FROM notifications
            WHERE user_id = ANY($1::uuid[])
        )
        DELETE FROM notifications notification
        USING ranked
        WHERE notification.id = ranked.id
          AND (
            ranked.position > $2
            OR ranked.created_at < NOW() - INTERVAL '180 days'
          )"#,
    )
    .bind(user_ids)
    .bind(MAX_NOTIFICATIONS_PER_USER)
    .execute(&mut **tx)
    .await?;

    Ok(())
}

pub async fn remove(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    actor_id: Uuid,
    kind: &'static str,
) -> Result<(), AppError> {
    sqlx::query("DELETE FROM notifications WHERE user_id = $1 AND actor_id = $2 AND kind = $3")
        .bind(user_id)
        .bind(actor_id)
        .bind(kind)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

pub async fn remove_many(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    actor_ids: &[Uuid],
    kind: &'static str,
) -> Result<(), AppError> {
    if actor_ids.is_empty() {
        return Ok(());
    }

    sqlx::query(
        "DELETE FROM notifications
         WHERE user_id = $1 AND actor_id = ANY($2::uuid[]) AND kind = $3",
    )
    .bind(user_id)
    .bind(actor_ids)
    .bind(kind)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn prune_user(tx: &mut Transaction<'_, Postgres>, user_id: Uuid) -> Result<(), AppError> {
    sqlx::query(
        r#"DELETE FROM notifications
        WHERE user_id = $1
          AND (
            created_at < NOW() - INTERVAL '180 days'
            OR id IN (
                SELECT id
                FROM notifications
                WHERE user_id = $1
                ORDER BY created_at DESC, id DESC
                OFFSET $2
            )
          )"#,
    )
    .bind(user_id)
    .bind(MAX_NOTIFICATIONS_PER_USER)
    .execute(&mut **tx)
    .await?;
    Ok(())
}
