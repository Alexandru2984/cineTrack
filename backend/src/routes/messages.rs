use actix_web::{web, HttpRequest, HttpResponse};
use serde_json::json;
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::dto::common::PaginationParams;
use crate::dto::message::{
    ConversationResponse, DirectMessageResponse, EncryptedEnvelope, MarkThreadReadRequest,
    MessageHistoryParams, MessagePeerResponse, MessageSummaryResponse, MessageThreadResponse,
    SendMessageRequest,
};
use crate::errors::AppError;
use crate::middleware::auth::require_auth;
use crate::services::{community_safety, franking, quota};

pub const MAX_MESSAGES_PER_MINUTE: i64 = 30;
pub const MAX_MESSAGES_PER_DAY: i64 = 500;

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::scope("/messages")
            .route("", web::get().to(list_conversations))
            .route("/summary", web::get().to(message_summary))
            .route("/{username}", web::get().to(get_thread))
            .route("/{username}", web::post().to(send_message))
            .route("/{username}/read", web::post().to(mark_thread_read)),
    );
}

/// Render a validation error for the caller, preferring its message over its
/// machine-readable code.
fn describe_validation(error: &validator::ValidationError) -> String {
    error
        .message
        .as_ref()
        .map_or_else(|| error.code.to_string(), std::string::ToString::to_string)
}

async fn resolve_peer(pool: &PgPool, username: &str) -> Result<MessagePeerResponse, AppError> {
    let row = sqlx::query_as::<_, (Uuid, String, Option<String>)>(
        "SELECT id, username, avatar_url FROM users WHERE LOWER(username) = LOWER($1)",
    )
    .bind(username)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("User not found".to_string()))?;

    Ok(MessagePeerResponse {
        id: row.0,
        username: row.1,
        avatar_url: row.2,
    })
}

async fn resolve_peer_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    username: &str,
) -> Result<MessagePeerResponse, AppError> {
    let row = sqlx::query_as::<_, (Uuid, String, Option<String>)>(
        "SELECT id, username, avatar_url FROM users WHERE LOWER(username) = LOWER($1) FOR SHARE",
    )
    .bind(username)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| AppError::NotFound("User not found".to_string()))?;

    Ok(MessagePeerResponse {
        id: row.0,
        username: row.1,
        avatar_url: row.2,
    })
}

async fn mutual_follow_exists(
    pool: &PgPool,
    first_user_id: Uuid,
    second_user_id: Uuid,
) -> Result<bool, AppError> {
    Ok(sqlx::query_scalar::<_, bool>(
        r#"SELECT
            EXISTS(
                SELECT 1 FROM follows
                WHERE follower_id = $1 AND following_id = $2 AND status = 'accepted'
            )
            AND EXISTS(
                SELECT 1 FROM follows
                WHERE follower_id = $2 AND following_id = $1 AND status = 'accepted'
            )
            AND NOT EXISTS(
                SELECT 1 FROM user_blocks block
                WHERE
                    (block.blocker_id = $1 AND block.blocked_id = $2)
                    OR (block.blocker_id = $2 AND block.blocked_id = $1)
            )"#,
    )
    .bind(first_user_id)
    .bind(second_user_id)
    .fetch_one(pool)
    .await?)
}

async fn mutual_follow_exists_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    first_user_id: Uuid,
    second_user_id: Uuid,
) -> Result<bool, AppError> {
    Ok(sqlx::query_scalar::<_, bool>(
        r#"SELECT
            EXISTS(
                SELECT 1 FROM follows
                WHERE follower_id = $1 AND following_id = $2 AND status = 'accepted'
            )
            AND EXISTS(
                SELECT 1 FROM follows
                WHERE follower_id = $2 AND following_id = $1 AND status = 'accepted'
            )"#,
    )
    .bind(first_user_id)
    .bind(second_user_id)
    .fetch_one(&mut **tx)
    .await?)
}

async fn conversation_exists(
    pool: &PgPool,
    first_user_id: Uuid,
    second_user_id: Uuid,
) -> Result<bool, AppError> {
    Ok(sqlx::query_scalar::<_, bool>(
        r#"SELECT EXISTS(
            SELECT 1 FROM direct_messages
            WHERE
                (sender_id = $1 AND recipient_id = $2)
                OR (sender_id = $2 AND recipient_id = $1)
        )"#,
    )
    .bind(first_user_id)
    .bind(second_user_id)
    .fetch_one(pool)
    .await?)
}

async fn list_conversations(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    pagination: web::Query<PaginationParams>,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    let conversations = sqlx::query_as::<_, ConversationResponse>(
        r#"WITH message_rows AS (
            SELECT
                message.*,
                CASE
                    WHEN message.sender_id = $1 THEN message.recipient_id
                    ELSE message.sender_id
                END AS peer_id,
                ROW_NUMBER() OVER (
                    PARTITION BY CASE
                        WHEN message.sender_id = $1 THEN message.recipient_id
                        ELSE message.sender_id
                    END
                    ORDER BY message.created_at DESC, message.id DESC
                ) AS row_number,
                COUNT(*) FILTER (
                    WHERE message.recipient_id = $1 AND message.read_at IS NULL
                ) OVER (
                    PARTITION BY CASE
                        WHEN message.sender_id = $1 THEN message.recipient_id
                        ELSE message.sender_id
                    END
                ) AS unread_count
            FROM direct_messages message
            WHERE message.sender_id = $1 OR message.recipient_id = $1
        )
        SELECT
            peer.id AS user_id,
            peer.username,
            CASE WHEN EXISTS(
                SELECT 1 FROM user_blocks block
                WHERE
                    (block.blocker_id = $1 AND block.blocked_id = peer.id)
                    OR (block.blocker_id = peer.id AND block.blocked_id = $1)
            ) THEN NULL ELSE peer.avatar_url END AS avatar_url,
            latest.id AS last_message_id,
            latest.sender_id AS last_message_sender_id,
            latest.body AS last_message_body,
            latest.ciphertext AS last_message_ciphertext,
            latest.nonce AS last_message_nonce,
            latest.sender_ephemeral_key AS last_message_sender_ephemeral_key,
            latest.sender_copy AS last_message_sender_copy,
            latest.created_at AS last_message_at,
            latest.read_at AS last_message_read_at,
            latest.unread_count,
            (
                EXISTS(
                    SELECT 1 FROM follows
                    WHERE follower_id = $1 AND following_id = peer.id AND status = 'accepted'
                )
                AND EXISTS(
                    SELECT 1 FROM follows
                    WHERE follower_id = peer.id AND following_id = $1 AND status = 'accepted'
                )
                AND NOT EXISTS(
                    SELECT 1 FROM user_blocks block
                    WHERE
                        (block.blocker_id = $1 AND block.blocked_id = peer.id)
                        OR (block.blocker_id = peer.id AND block.blocked_id = $1)
                )
            ) AS can_message
        FROM message_rows latest
        JOIN users peer ON peer.id = latest.peer_id
        WHERE latest.row_number = 1
        ORDER BY latest.created_at DESC, latest.id DESC
        LIMIT $2 OFFSET $3"#,
    )
    .bind(user_id)
    .bind(pagination.limit_val())
    .bind(pagination.offset())
    .fetch_all(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok()
        .insert_header(("Cache-Control", "no-store"))
        .insert_header(("Pragma", "no-cache"))
        .json(conversations))
}

async fn message_summary(
    pool: web::Data<PgPool>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    let unread_count = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM direct_messages WHERE recipient_id = $1 AND read_at IS NULL",
    )
    .bind(user_id)
    .fetch_one(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok()
        .insert_header(("Cache-Control", "no-store"))
        .insert_header(("Pragma", "no-cache"))
        .json(MessageSummaryResponse { unread_count }))
}

async fn get_thread(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
    params: web::Query<MessageHistoryParams>,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    let mut peer = resolve_peer(pool.get_ref(), &path.into_inner()).await?;
    if peer.id == user_id {
        return Err(AppError::BadRequest(
            "Cannot open a conversation with yourself".to_string(),
        ));
    }

    let has_history = conversation_exists(pool.get_ref(), user_id, peer.id).await?;
    let can_message = mutual_follow_exists(pool.get_ref(), user_id, peer.id).await?;
    let is_blocked =
        community_safety::interaction_is_blocked(pool.get_ref(), user_id, peer.id).await?;
    if !has_history && !can_message {
        if is_blocked {
            return Err(AppError::NotFound("User not found".to_string()));
        }
        return Err(AppError::Forbidden(
            "Messages are available between mutual followers".to_string(),
        ));
    }
    if is_blocked {
        peer.avatar_url = None;
    }

    let cursor = params
        .cursor()
        .map_err(|message| AppError::BadRequest(message.to_string()))?;
    let messages = if let Some((before, before_id)) = cursor {
        sqlx::query_as::<_, DirectMessageResponse>(
            r#"SELECT id, sender_id, recipient_id, body,
                       ciphertext, nonce, sender_ephemeral_key, sender_copy, franking_commitment,
                       read_at, created_at
            FROM (
                SELECT id, sender_id, recipient_id, body,
                       ciphertext, nonce, sender_ephemeral_key, sender_copy, franking_commitment,
                       read_at, created_at
                FROM direct_messages
                WHERE
                    ((sender_id = $1 AND recipient_id = $2)
                        OR (sender_id = $2 AND recipient_id = $1))
                    AND (created_at, id) < ($3, $4)
                ORDER BY created_at DESC, id DESC
                LIMIT $5
            ) recent
            ORDER BY created_at, id"#,
        )
        .bind(user_id)
        .bind(peer.id)
        .bind(before)
        .bind(before_id)
        .bind(params.limit_val())
        .fetch_all(pool.get_ref())
        .await?
    } else {
        sqlx::query_as::<_, DirectMessageResponse>(
            r#"SELECT id, sender_id, recipient_id, body,
                       ciphertext, nonce, sender_ephemeral_key, sender_copy, franking_commitment,
                       read_at, created_at
            FROM (
                SELECT id, sender_id, recipient_id, body,
                       ciphertext, nonce, sender_ephemeral_key, sender_copy, franking_commitment,
                       read_at, created_at
                FROM direct_messages
                WHERE
                    (sender_id = $1 AND recipient_id = $2)
                    OR (sender_id = $2 AND recipient_id = $1)
                ORDER BY created_at DESC, id DESC
                LIMIT $3
            ) recent
            ORDER BY created_at, id"#,
        )
        .bind(user_id)
        .bind(peer.id)
        .bind(params.limit_val())
        .fetch_all(pool.get_ref())
        .await?
    };

    Ok(HttpResponse::Ok()
        .insert_header(("Cache-Control", "no-store"))
        .insert_header(("Pragma", "no-cache"))
        .json(MessageThreadResponse {
            user: peer,
            can_message,
            messages,
        }))
}

/// Whether both accounts have published identity keys, and so must use them.
///
/// Counting rather than fetching: the keys themselves are not needed here, only
/// whether encryption is possible for this pair.
async fn both_parties_can_encrypt(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    sender_id: Uuid,
    recipient_id: Uuid,
) -> Result<bool, AppError> {
    let published = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM user_identity_keys WHERE user_id = ANY($1)",
    )
    .bind(vec![sender_id, recipient_id])
    .fetch_one(&mut **tx)
    .await?;
    Ok(published == 2)
}

async fn send_message(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<SendMessageRequest>,
) -> Result<HttpResponse, AppError> {
    let sender_id = require_auth(&req).await?;
    crate::services::auth::require_verified_email(pool.get_ref(), sender_id).await?;
    crate::services::legal::require_current_terms(pool.get_ref(), sender_id).await?;
    body.validate_content()
        .map_err(|error| AppError::BadRequest(describe_validation(&error)))?;
    let data = body.into_inner();
    let normalized_body = data.normalized_body();
    let envelope = data
        .envelope()
        .map(EncryptedEnvelope::decode)
        .transpose()
        .map_err(|error| AppError::BadRequest(describe_validation(&error)))?;

    let mut tx = pool.begin().await?;
    let peer = resolve_peer_in_tx(&mut tx, &path.into_inner()).await?;
    if peer.id == sender_id {
        return Err(AppError::BadRequest(
            "Cannot send a message to yourself".to_string(),
        ));
    }

    quota::lock_social_relationship_writes(&mut tx, sender_id, peer.id).await?;
    if community_safety::interaction_is_blocked_in_tx(&mut tx, sender_id, peer.id).await? {
        return Err(AppError::NotFound("User not found".to_string()));
    }
    if !mutual_follow_exists_in_tx(&mut tx, sender_id, peer.id).await? {
        return Err(AppError::Forbidden(
            "Messages are available between mutual followers".to_string(),
        ));
    }

    // The switching rule, enforced where it cannot be bypassed.
    //
    // Clients choose plaintext or an envelope by looking up the recipient's
    // published key, and that decision is the right one to make on the client —
    // it is the only place that knows whether it can actually encrypt. But a
    // decision made only on the client is a decision an attacker can make
    // instead: strip the key lookup, send plaintext, and the server would store
    // it. So the server re-derives the same rule from its own key directory and
    // refuses plaintext once both sides have published keys.
    //
    // This can only reject a client that published a key and then sent
    // plaintext anyway — which is to say a client that is out of date or lying.
    // The message says which.
    if envelope.is_none() && both_parties_can_encrypt(&mut tx, sender_id, peer.id).await? {
        return Err(AppError::BadRequest(
            "Both accounts have encryption keys, so this conversation is end-to-end \
             encrypted. Update the app to send messages here."
                .to_string(),
        ));
    }

    // Check the sender's signature now, and record the key it was checked
    // against.
    //
    // The signature covers `commitment || client_nonce`, and the server holds
    // both along with the sender's public key — so there was never a reason to
    // store it unverified. Storing it unverified had a cost that only appeared
    // much later: a client sending a wrong or random signature produced a
    // message that displayed perfectly and could never be reported, because the
    // evidence only gets checked when a victim tries to use it.
    //
    // The recorded key is what makes the report survive a rotation.
    // `user_identity_keys` keeps one row per user and replacing keys
    // overwrites it, so verifying a report against the sender's *current* key
    // meant: send abuse, rotate keys, and the report can no longer be verified.
    let sender_signing_key = match envelope.as_ref() {
        None => None,
        Some(envelope) => {
            let key = sqlx::query_scalar::<_, Vec<u8>>(
                "SELECT signing_public_key FROM user_identity_keys WHERE user_id = $1",
            )
            .bind(sender_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| {
                AppError::BadRequest(
                    "Publish your encryption keys before sending an encrypted message.".to_string(),
                )
            })?;

            if let Err(failure) = franking::verify_signature(
                &envelope.franking_commitment,
                &envelope.franking_signature,
                &key,
                data.client_nonce(),
            ) {
                log::warn!(
                    "audit: rejected direct message with unusable franking signature \
                     sender_id={sender_id} recipient_id={} reason={}",
                    peer.id,
                    failure.as_str()
                );
                return Err(AppError::BadRequest(
                    "This message could not be signed correctly and was not sent. \
                     Update the app and try again."
                        .to_string(),
                ));
            }
            Some(key)
        }
    };

    let existing = sqlx::query_as::<_, DirectMessageResponse>(
        r#"SELECT id, sender_id, recipient_id, body,
                       ciphertext, nonce, sender_ephemeral_key, sender_copy, franking_commitment,
                       read_at, created_at
        FROM direct_messages
        WHERE sender_id = $1 AND client_nonce = $2"#,
    )
    .bind(sender_id)
    .bind(data.client_nonce())
    .fetch_optional(&mut *tx)
    .await?;
    if let Some(existing) = existing {
        // Compare whichever form this send took. An encrypted retry cannot be
        // compared by content — the ciphertext differs every time by design —
        // so matching the recipient and the stored form is as far as this can
        // honestly go.
        let same_content = match (&existing.body, &normalized_body) {
            (Some(stored), Some(sent)) => stored == sent,
            (None, None) => true,
            _ => false,
        };
        if existing.recipient_id != peer.id || !same_content {
            return Err(AppError::Conflict(
                "Message idempotency key was already used".to_string(),
            ));
        }
        tx.commit().await?;
        return Ok(HttpResponse::Ok()
            .insert_header(("Cache-Control", "no-store"))
            .insert_header(("Pragma", "no-cache"))
            .json(existing));
    }

    let (minute_count, day_count) = sqlx::query_as::<_, (i64, i64)>(
        r#"SELECT
            COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '1 minute'),
            COUNT(*)
        FROM direct_messages
        WHERE sender_id = $1
          AND created_at >= NOW() - INTERVAL '24 hours'"#,
    )
    .bind(sender_id)
    .fetch_one(&mut *tx)
    .await?;
    if minute_count >= MAX_MESSAGES_PER_MINUTE || day_count >= MAX_MESSAGES_PER_DAY {
        return Err(AppError::TooManyRequests(
            "Message limit reached. Try again later.".to_string(),
        ));
    }

    for participant_id in [sender_id, peer.id] {
        let message_count = sqlx::query_scalar::<_, i64>(
            r#"SELECT COUNT(*) FROM direct_messages
            WHERE sender_id = $1 OR recipient_id = $1"#,
        )
        .bind(participant_id)
        .fetch_one(&mut *tx)
        .await?;
        quota::ensure_direct_message_capacity(message_count, 1)?;
    }

    let message = sqlx::query_as::<_, DirectMessageResponse>(
        r#"INSERT INTO direct_messages (
            sender_id, recipient_id, client_nonce, body,
            ciphertext, nonce, sender_ephemeral_key, sender_copy,
            franking_commitment, franking_signature, sender_signing_key
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING id, sender_id, recipient_id, body,
                  ciphertext, nonce, sender_ephemeral_key, sender_copy,
                  franking_commitment, read_at, created_at"#,
    )
    .bind(sender_id)
    .bind(peer.id)
    .bind(data.client_nonce())
    .bind(normalized_body)
    .bind(envelope.as_ref().map(|e| &e.ciphertext))
    .bind(envelope.as_ref().map(|e| &e.nonce))
    .bind(envelope.as_ref().map(|e| &e.sender_ephemeral_key))
    .bind(envelope.as_ref().map(|e| &e.sender_copy))
    .bind(envelope.as_ref().map(|e| &e.franking_commitment))
    .bind(envelope.as_ref().map(|e| &e.franking_signature))
    .bind(sender_signing_key.as_ref())
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;

    log::info!(
        "audit: direct message sent message_id={} sender_id={sender_id} recipient_id={}",
        message.id,
        peer.id
    );
    // Wake the recipient's open clients so they refetch, instead of finding out
    // on their next ten-second poll. After the commit: a signal for a message
    // that did not land would be a phantom.
    crate::services::events::publish(peer.id, crate::services::events::UserEvent::MessagesChanged);
    Ok(HttpResponse::Created()
        .insert_header(("Cache-Control", "no-store"))
        .insert_header(("Pragma", "no-cache"))
        .json(message))
}

async fn mark_thread_read(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<MarkThreadReadRequest>,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    let peer = resolve_peer(pool.get_ref(), &path.into_inner()).await?;
    if peer.id == user_id {
        return Err(AppError::BadRequest(
            "Cannot open a conversation with yourself".to_string(),
        ));
    }
    let through = sqlx::query_as::<_, (chrono::DateTime<chrono::Utc>, Uuid)>(
        r#"SELECT created_at, id FROM direct_messages
        WHERE id = $1 AND sender_id = $2 AND recipient_id = $3"#,
    )
    .bind(body.through_id)
    .bind(peer.id)
    .bind(user_id)
    .fetch_optional(pool.get_ref())
    .await?
    .ok_or_else(|| AppError::NotFound("Message not found".to_string()))?;

    let updated_count = sqlx::query(
        r#"UPDATE direct_messages
        SET read_at = NOW()
        WHERE sender_id = $1
          AND recipient_id = $2
          AND read_at IS NULL
          AND (created_at, id) <= ($3, $4)"#,
    )
    .bind(peer.id)
    .bind(user_id)
    .bind(through.0)
    .bind(through.1)
    .execute(pool.get_ref())
    .await?
    .rows_affected();

    if updated_count > 0 {
        // The reader's own other devices are showing a stale unread badge.
        crate::services::events::publish(
            user_id,
            crate::services::events::UserEvent::MessagesChanged,
        );
    }

    Ok(HttpResponse::Ok()
        .insert_header(("Cache-Control", "no-store"))
        .insert_header(("Pragma", "no-cache"))
        .json(json!({ "updated_count": updated_count })))
}
