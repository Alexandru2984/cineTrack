use std::collections::HashMap;
use std::time::Duration;

use chrono::Utc;
use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

use crate::config::Config;
use crate::errors::AppError;

const EXPO_SEND_URL: &str = "https://exp.host/--/api/v2/push/send";
const EXPO_RECEIPTS_URL: &str = "https://exp.host/--/api/v2/push/getReceipts";
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const SEND_BATCH_SIZE: i64 = 100;
const SEND_BUDGET: usize = 500;
const RECEIPT_BATCH_SIZE: i64 = 1000;
const MAX_ATTEMPTS: i16 = 5;
const PUSH_ADVISORY_LOCK: i64 = 0x5641_5a55_5445_5055;

#[derive(Clone)]
pub struct ExpoPushService {
    client: reqwest::Client,
}

#[derive(Debug, Default, Eq, PartialEq)]
pub struct PushDispatchSummary {
    pub enqueued: u64,
    pub submitted: usize,
    pub delivered: usize,
    pub retried: usize,
    pub failed: usize,
    pub disabled_devices: usize,
    pub pruned: u64,
    pub skipped_locked: bool,
}

#[derive(Debug, FromRow)]
struct PendingDelivery {
    id: Uuid,
    expo_push_token: String,
    event_key: String,
    title: String,
    body: String,
    tmdb_id: i32,
    media_type: String,
    attempt_count: i16,
}

#[derive(Debug, FromRow)]
struct TicketedDelivery {
    id: Uuid,
    push_device_id: Uuid,
    ticket_id: String,
    attempt_count: i16,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExpoPushMessage<'a> {
    to: &'a str,
    title: &'a str,
    body: &'a str,
    data: ExpoPushData<'a>,
    sound: &'static str,
    channel_id: &'static str,
    ttl: u32,
    priority: &'static str,
    collapse_id: &'a str,
    tag: &'a str,
}

#[derive(Debug, Serialize)]
struct ExpoPushData<'a> {
    kind: &'static str,
    tmdb_id: i32,
    media_type: &'a str,
}

#[derive(Debug, Deserialize)]
struct ExpoResult {
    status: String,
    id: Option<String>,
    details: Option<ExpoDetails>,
}

#[derive(Debug, Deserialize)]
struct ExpoDetails {
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ExpoRequestError {
    code: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ExpoTicketEnvelope {
    #[serde(default)]
    data: Vec<ExpoResult>,
    #[serde(default)]
    errors: Vec<ExpoRequestError>,
}

#[derive(Debug, Deserialize)]
struct ExpoReceiptEnvelope {
    #[serde(default)]
    data: HashMap<String, ExpoResult>,
    #[serde(default)]
    errors: Vec<ExpoRequestError>,
}

impl ExpoPushService {
    pub fn new(config: &Config) -> Self {
        let mut headers = HeaderMap::new();
        if let Some(token) = &config.expo_push_access_token {
            let mut value = HeaderValue::from_str(&format!("Bearer {token}"))
                .expect("Validated Expo access token must be header-safe");
            value.set_sensitive(true);
            headers.insert(AUTHORIZATION, value);
        }
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(config.expo_push_timeout_seconds))
            .connect_timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none())
            .default_headers(headers)
            .user_agent("cinetrack/0.1")
            .build()
            .expect("Failed to build Expo push HTTP client");
        Self { client }
    }

    async fn post_json<T: for<'de> Deserialize<'de>, B: Serialize + ?Sized>(
        &self,
        url: &str,
        body: &B,
    ) -> Result<T, AppError> {
        let response = self
            .client
            .post(url)
            .json(body)
            .send()
            .await
            .map_err(|error| {
                log::error!(
                    "Expo push request failed: timeout={} connect={}",
                    error.is_timeout(),
                    error.is_connect()
                );
                AppError::ServiceUnavailable("Push notification service unavailable".to_string())
            })?;
        let status = response.status();
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS || status.is_server_error() {
            return Err(AppError::ServiceUnavailable(
                "Push notification service unavailable".to_string(),
            ));
        }
        if !status.is_success() {
            log::error!("Expo push request rejected with status {status}");
            return Err(AppError::BadRequest(
                "Push notification service rejected the request".to_string(),
            ));
        }

        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| {
                AppError::ServiceUnavailable(
                    "Push notification service response failed".to_string(),
                )
            })?;
            if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
                return Err(AppError::ServiceUnavailable(
                    "Push notification service response was oversized".to_string(),
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| {
            AppError::ServiceUnavailable(
                "Push notification service returned an invalid response".to_string(),
            )
        })
    }

    async fn send(&self, deliveries: &[PendingDelivery]) -> Result<Vec<ExpoResult>, AppError> {
        let messages = deliveries
            .iter()
            .map(|delivery| ExpoPushMessage {
                to: &delivery.expo_push_token,
                title: &delivery.title,
                body: &delivery.body,
                data: ExpoPushData {
                    kind: "release",
                    tmdb_id: delivery.tmdb_id,
                    media_type: &delivery.media_type,
                },
                sound: "default",
                channel_id: "releases",
                ttl: 86_400,
                priority: "default",
                collapse_id: &delivery.event_key,
                tag: &delivery.event_key,
            })
            .collect::<Vec<_>>();
        let response: ExpoTicketEnvelope = self.post_json(EXPO_SEND_URL, &messages).await?;
        if !response.errors.is_empty() || response.data.len() != deliveries.len() {
            let code = response
                .errors
                .first()
                .and_then(|error| error.code.as_deref())
                .unwrap_or("invalid_response");
            log::error!("Expo push batch failed: code={code}");
            return Err(AppError::ServiceUnavailable(
                "Push notification batch failed".to_string(),
            ));
        }
        Ok(response.data)
    }

    async fn receipts(
        &self,
        ticket_ids: &[String],
    ) -> Result<HashMap<String, ExpoResult>, AppError> {
        #[derive(Serialize)]
        struct ReceiptRequest<'a> {
            ids: &'a [String],
        }
        let response: ExpoReceiptEnvelope = self
            .post_json(EXPO_RECEIPTS_URL, &ReceiptRequest { ids: ticket_ids })
            .await?;
        if !response.errors.is_empty() {
            let code = response
                .errors
                .first()
                .and_then(|error| error.code.as_deref())
                .unwrap_or("invalid_response");
            log::error!("Expo push receipt request failed: code={code}");
            return Err(AppError::ServiceUnavailable(
                "Push notification receipt request failed".to_string(),
            ));
        }
        Ok(response.data)
    }
}

fn retry_delay(attempt_count: i16) -> chrono::Duration {
    let exponent = u32::from(attempt_count.clamp(0, 5) as u16);
    chrono::Duration::hours(i64::from(1_u32 << exponent).min(24))
}

fn expo_error_code(result: &ExpoResult) -> &str {
    result
        .details
        .as_ref()
        .and_then(|details| details.error.as_deref())
        .unwrap_or("UnknownPushError")
}

pub async fn enqueue_due_release_pushes(pool: &PgPool) -> Result<u64, sqlx::Error> {
    let episodes = sqlx::query(
        r#"INSERT INTO release_push_deliveries
            (push_device_id, event_key, event_kind, title, body, tmdb_id, media_type)
        SELECT
            device.id,
            'episode:' || episode.id::text,
            'episode',
            LEFT(media.title, 120),
            LEFT(
                FORMAT(
                    'S%sE%s%s is now available',
                    LPAD(season.season_number::text, 2, '0'),
                    LPAD(episode.episode_number::text, 2, '0'),
                    CASE
                        WHEN NULLIF(BTRIM(episode.name), '') IS NULL THEN ''
                        ELSE ' · ' || episode.name
                    END
                ),
                300
            ),
            media.tmdb_id,
            'tv'
        FROM push_devices device
        JOIN user_media tracked ON tracked.user_id = device.user_id
        JOIN media ON media.id = tracked.media_id AND media.media_type = 'tv'
        JOIN seasons season ON season.media_id = media.id AND season.season_number > 0
        JOIN episodes episode ON episode.season_id = season.id
        WHERE tracked.status <> 'dropped'
          AND episode.air_date = (
              NOW() + MAKE_INTERVAL(mins => device.utc_offset_minutes)
          )::date
          AND episode.air_date >= (
              device.enabled_at + MAKE_INTERVAL(mins => device.utc_offset_minutes)
          )::date
          AND NOT EXISTS (
              SELECT 1 FROM watch_history history
              WHERE history.user_id = device.user_id
                AND history.episode_id = episode.id
          )
        ON CONFLICT (push_device_id, event_key) DO NOTHING"#,
    )
    .execute(pool)
    .await?
    .rows_affected();

    let movies = sqlx::query(
        r#"INSERT INTO release_push_deliveries
            (push_device_id, event_key, event_kind, title, body, tmdb_id, media_type)
        SELECT
            device.id,
            'movie:' || media.id::text || ':' || local_date.value::text,
            'movie',
            LEFT(media.title, 120),
            LEFT('A movie from your plan is now available', 300),
            media.tmdb_id,
            'movie'
        FROM push_devices device
        CROSS JOIN LATERAL (
            SELECT (
                NOW() + MAKE_INTERVAL(mins => device.utc_offset_minutes)
            )::date AS value
        ) local_date
        JOIN user_media tracked
          ON tracked.user_id = device.user_id
         AND tracked.status = 'plan_to_watch'
        JOIN media ON media.id = tracked.media_id AND media.media_type = 'movie'
        LEFT JOIN user_calendar_preferences preference
          ON preference.user_id = device.user_id
        WHERE local_date.value >= (
              device.enabled_at + MAKE_INTERVAL(mins => device.utc_offset_minutes)
          )::date
          AND (
              EXISTS (
                  SELECT 1 FROM media_release_dates release
                  WHERE release.media_id = media.id
                    AND release.country_code = COALESCE(preference.country_code, 'RO')
                    AND release.release_date = local_date.value
              )
              OR (
                  NOT EXISTS (
                      SELECT 1 FROM media_release_dates release
                      WHERE release.media_id = media.id
                        AND release.country_code = COALESCE(preference.country_code, 'RO')
                  )
                  AND media.release_date = local_date.value
              )
          )
        ON CONFLICT (push_device_id, event_key) DO NOTHING"#,
    )
    .execute(pool)
    .await?
    .rows_affected();

    Ok(episodes + movies)
}

async fn schedule_retry(
    pool: &PgPool,
    delivery_id: Uuid,
    next_attempt_count: i16,
    error_code: &str,
) -> Result<bool, sqlx::Error> {
    let failed = next_attempt_count >= MAX_ATTEMPTS;
    sqlx::query(
        "UPDATE release_push_deliveries SET
            status = $2,
            attempt_count = $3,
            next_attempt_at = $4,
            ticket_id = NULL,
            ticketed_at = NULL,
            last_error = $5,
            updated_at = NOW()
         WHERE id = $1",
    )
    .bind(delivery_id)
    .bind(if failed { "failed" } else { "pending" })
    .bind(next_attempt_count)
    .bind(Utc::now() + retry_delay(next_attempt_count))
    .bind(error_code.chars().take(500).collect::<String>())
    .execute(pool)
    .await?;
    Ok(failed)
}

async fn process_receipts(
    pool: &PgPool,
    service: &ExpoPushService,
    summary: &mut PushDispatchSummary,
) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE release_push_deliveries SET
            status = CASE WHEN attempt_count >= $1 THEN 'failed' ELSE 'pending' END,
            next_attempt_at = NOW(),
            ticket_id = NULL,
            ticketed_at = NULL,
            last_error = 'ReceiptUnavailable',
            updated_at = NOW()
         WHERE status = 'ticketed' AND ticketed_at < NOW() - INTERVAL '24 hours'",
    )
    .bind(MAX_ATTEMPTS)
    .execute(pool)
    .await?;

    let deliveries = sqlx::query_as::<_, TicketedDelivery>(
        "SELECT id, push_device_id, ticket_id, attempt_count
         FROM release_push_deliveries
         WHERE status = 'ticketed'
           AND ticketed_at <= NOW() - INTERVAL '15 minutes'
           AND ticketed_at >= NOW() - INTERVAL '24 hours'
         ORDER BY ticketed_at, id
         LIMIT $1",
    )
    .bind(RECEIPT_BATCH_SIZE)
    .fetch_all(pool)
    .await?;
    if deliveries.is_empty() {
        return Ok(());
    }

    let ticket_ids = deliveries
        .iter()
        .map(|delivery| delivery.ticket_id.clone())
        .collect::<Vec<_>>();
    let receipts = service.receipts(&ticket_ids).await?;
    for delivery in deliveries {
        let Some(receipt) = receipts.get(&delivery.ticket_id) else {
            continue;
        };
        if receipt.status == "ok" {
            sqlx::query(
                "UPDATE release_push_deliveries
                 SET status = 'delivered', last_error = NULL, updated_at = NOW()
                 WHERE id = $1 AND status = 'ticketed'",
            )
            .bind(delivery.id)
            .execute(pool)
            .await?;
            summary.delivered += 1;
            continue;
        }

        let error_code = expo_error_code(receipt);
        if error_code == "DeviceNotRegistered" {
            sqlx::query("DELETE FROM push_devices WHERE id = $1")
                .bind(delivery.push_device_id)
                .execute(pool)
                .await?;
            summary.disabled_devices += 1;
        } else if error_code == "MessageRateExceeded" {
            let failed =
                schedule_retry(pool, delivery.id, delivery.attempt_count, error_code).await?;
            if failed {
                summary.failed += 1;
            } else {
                summary.retried += 1;
            }
        } else {
            sqlx::query(
                "UPDATE release_push_deliveries SET
                    status = 'failed', last_error = $2, updated_at = NOW()
                 WHERE id = $1",
            )
            .bind(delivery.id)
            .bind(error_code.chars().take(500).collect::<String>())
            .execute(pool)
            .await?;
            summary.failed += 1;
            log::error!("Expo push receipt failed: code={error_code}");
        }
    }
    Ok(())
}

async fn submit_pending(
    pool: &PgPool,
    service: &ExpoPushService,
    summary: &mut PushDispatchSummary,
) -> Result<(), AppError> {
    while summary.submitted < SEND_BUDGET {
        let remaining = i64::try_from(SEND_BUDGET - summary.submitted)
            .expect("push send budget must fit in i64");
        let deliveries = sqlx::query_as::<_, PendingDelivery>(
            "SELECT delivery.id, device.expo_push_token, delivery.event_key,
                    delivery.title, delivery.body, delivery.tmdb_id,
                    delivery.media_type, delivery.attempt_count
             FROM release_push_deliveries delivery
             JOIN push_devices device ON device.id = delivery.push_device_id
             WHERE delivery.status = 'pending'
               AND delivery.next_attempt_at <= NOW()
             ORDER BY delivery.next_attempt_at, delivery.id
             LIMIT $1",
        )
        .bind(SEND_BATCH_SIZE.min(remaining))
        .fetch_all(pool)
        .await?;
        if deliveries.is_empty() {
            break;
        }

        let tickets = match service.send(&deliveries).await {
            Ok(tickets) => tickets,
            Err(error) => {
                for delivery in deliveries {
                    let failed = schedule_retry(
                        pool,
                        delivery.id,
                        delivery.attempt_count + 1,
                        "PushServiceUnavailable",
                    )
                    .await?;
                    if failed {
                        summary.failed += 1;
                    } else {
                        summary.retried += 1;
                    }
                }
                return Err(error);
            }
        };

        for (delivery, ticket) in deliveries.iter().zip(tickets) {
            if ticket.status == "ok" {
                if let Some(ticket_id) = ticket.id {
                    sqlx::query(
                        "UPDATE release_push_deliveries SET
                            status = 'ticketed', attempt_count = attempt_count + 1,
                            ticket_id = $2, ticketed_at = NOW(), last_error = NULL,
                            updated_at = NOW()
                         WHERE id = $1 AND status = 'pending'",
                    )
                    .bind(delivery.id)
                    .bind(ticket_id)
                    .execute(pool)
                    .await?;
                    summary.submitted += 1;
                    continue;
                }
            }

            let error_code = expo_error_code(&ticket);
            if error_code == "DeviceNotRegistered" {
                sqlx::query(
                    "DELETE FROM push_devices
                     WHERE expo_push_token = $1",
                )
                .bind(&delivery.expo_push_token)
                .execute(pool)
                .await?;
                summary.disabled_devices += 1;
            } else if error_code == "MessageRateExceeded" || ticket.status == "ok" {
                let failed =
                    schedule_retry(pool, delivery.id, delivery.attempt_count + 1, error_code)
                        .await?;
                if failed {
                    summary.failed += 1;
                } else {
                    summary.retried += 1;
                }
            } else {
                sqlx::query(
                    "UPDATE release_push_deliveries SET
                        status = 'failed', attempt_count = attempt_count + 1,
                        last_error = $2, updated_at = NOW()
                     WHERE id = $1",
                )
                .bind(delivery.id)
                .bind(error_code.chars().take(500).collect::<String>())
                .execute(pool)
                .await?;
                summary.failed += 1;
                log::error!("Expo push ticket failed: code={error_code}");
            }
        }
    }
    Ok(())
}

pub async fn dispatch_release_pushes(
    pool: &PgPool,
    service: &ExpoPushService,
) -> Result<PushDispatchSummary, AppError> {
    let mut lock_transaction = pool.begin().await?;
    let acquired = sqlx::query_scalar::<_, bool>("SELECT pg_try_advisory_xact_lock($1)")
        .bind(PUSH_ADVISORY_LOCK)
        .fetch_one(&mut *lock_transaction)
        .await?;
    if !acquired {
        return Ok(PushDispatchSummary {
            skipped_locked: true,
            ..PushDispatchSummary::default()
        });
    }

    let mut summary = PushDispatchSummary {
        enqueued: enqueue_due_release_pushes(pool).await?,
        ..PushDispatchSummary::default()
    };
    process_receipts(pool, service, &mut summary).await?;
    submit_pending(pool, service, &mut summary).await?;
    summary.pruned = sqlx::query(
        "DELETE FROM release_push_deliveries
         WHERE status IN ('delivered', 'failed')
           AND updated_at < NOW() - INTERVAL '30 days'",
    )
    .execute(pool)
    .await?
    .rows_affected();
    lock_transaction.rollback().await?;
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_backoff_is_bounded() {
        assert_eq!(retry_delay(0), chrono::Duration::hours(1));
        assert_eq!(retry_delay(3), chrono::Duration::hours(8));
        assert_eq!(retry_delay(8), chrono::Duration::hours(24));
    }

    #[test]
    fn push_message_is_small_and_contains_only_navigation_context() {
        let delivery = PendingDelivery {
            id: Uuid::nil(),
            expo_push_token: "ExpoPushToken[abcdefghijklmnopqrstuv]".to_string(),
            event_key: format!("episode:{}", Uuid::nil()),
            title: "Example Show".to_string(),
            body: "S01E02 is now available".to_string(),
            tmdb_id: 42,
            media_type: "tv".to_string(),
            attempt_count: 0,
        };
        let message = ExpoPushMessage {
            to: &delivery.expo_push_token,
            title: &delivery.title,
            body: &delivery.body,
            data: ExpoPushData {
                kind: "release",
                tmdb_id: delivery.tmdb_id,
                media_type: &delivery.media_type,
            },
            sound: "default",
            channel_id: "releases",
            ttl: 86_400,
            priority: "default",
            collapse_id: &delivery.event_key,
            tag: &delivery.event_key,
        };
        let payload = serde_json::to_value(message).unwrap();
        assert_eq!(payload["data"]["tmdb_id"], 42);
        assert_eq!(payload["data"]["media_type"], "tv");
        assert!(payload.get("user_id").is_none());
        assert!(serde_json::to_vec(&payload).unwrap().len() < 4096);
    }

    #[test]
    fn parses_expo_ticket_and_receipt_envelopes() {
        let tickets: ExpoTicketEnvelope = serde_json::from_str(
            r#"{"data":[{"status":"ok","id":"ticket-1"},{"status":"error","details":{"error":"DeviceNotRegistered"}}]}"#,
        )
        .unwrap();
        assert_eq!(tickets.data.len(), 2);
        assert_eq!(tickets.data[0].id.as_deref(), Some("ticket-1"));
        assert_eq!(expo_error_code(&tickets.data[1]), "DeviceNotRegistered");

        let receipts: ExpoReceiptEnvelope = serde_json::from_str(
            r#"{"data":{"ticket-1":{"status":"ok"},"ticket-2":{"status":"error","details":{"error":"MessageRateExceeded"}}}}"#,
        )
        .unwrap();
        assert_eq!(receipts.data["ticket-1"].status, "ok");
        assert_eq!(
            expo_error_code(&receipts.data["ticket-2"]),
            "MessageRateExceeded"
        );
    }
}
