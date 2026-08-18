//! Server-sent events: one long-lived connection per client, replacing polling.
//!
//! SSE rather than WebSockets, for three reasons specific to this deployment.
//! The traffic is one-directional — the server has nothing to receive that an
//! ordinary request does not already carry. It survives the existing edge
//! unchanged, with no protocol upgrade for Cloudflare or nginx to negotiate.
//! And reconnection is part of the format, so a dropped connection is the
//! client's problem to retry rather than a state machine to write.
//!
//! # Authentication
//!
//! The browser `EventSource` API cannot set an `Authorization` header, which is
//! why so many SSE endpoints end up taking a token in the query string. That is
//! not done here: query strings reach access logs, `Referer` headers and browser
//! history, and this repository already went to some length to keep the calendar
//! feed token out of exactly those places. Clients stream this with `fetch`
//! instead, which carries the header normally.

use std::time::Duration;

use actix_web::{web, HttpRequest, HttpResponse};
use futures_util::stream;
use tokio::sync::broadcast::error::RecvError;
use uuid::Uuid;

use crate::config::Config;
use crate::errors::AppError;
use crate::middleware::auth::require_auth;
use crate::services::events::{self, UserEvent};
use crate::services::revocation;
use crate::utils::jwt;

/// How many simultaneous streams one account may hold.
///
/// A stream costs a task and a socket for as long as it is open, so without a
/// bound a single account could pin them by opening tabs. Five matches the
/// active-session cap, which is the same question asked about refresh tokens.
const MAX_CONNECTIONS_PER_USER: usize = 5;

/// Idle gap after which a comment frame is emitted.
///
/// Proxies close connections that go quiet, and a client cannot tell a healthy
/// idle stream from a dead one. Comment frames are ignored by the SSE parser,
/// so this is invisible to the application and only keeps the pipe warm.
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(25);

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.route("/events", web::get().to(stream_events));
}

/// A guard that frees the user's channel when the connection ends, however it
/// ends — returned normally, client disconnected, or the task was dropped.
/// Doing this in `Drop` rather than after the loop is what makes it hold for
/// the disconnect case, which is the common one.
struct ConnectionGuard {
    user_id: Uuid,
    /// The session and issue time this stream was opened with, so revocation
    /// can be re-checked while it is open.
    session_id: Uuid,
    issued_at: i64,
}

impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        events::release(self.user_id);
    }
}

fn frame(event: UserEvent) -> String {
    // `event:` lets a client register one handler per kind. The data payload is
    // still sent so a generic listener has something well-formed to parse, and
    // because a frame without a data line is not delivered at all.
    format!(
        "event: {}\ndata: {{\"kind\":\"{}\"}}\n\n",
        event.name(),
        event.name()
    )
}

/// Re-read the validated claims for this request.
///
/// `require_auth` returns only the user id, which is all an ordinary handler
/// needs. A stream also needs the session id and issue time, because it has to
/// answer the revocation question again later, and the token is not available
/// once the response has started.
fn session_claims(req: &HttpRequest) -> Result<jwt::Claims, AppError> {
    let config = req
        .app_data::<web::Data<Config>>()
        .ok_or_else(|| AppError::Unauthorized("Server configuration error".to_string()))?;
    let token = req
        .headers()
        .get(actix_web::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .ok_or_else(|| AppError::Unauthorized("Missing Authorization header".to_string()))?;
    jwt::validate_token(token, &config.jwt_secret)
}

async fn stream_events(req: HttpRequest) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;

    if events::connection_count(user_id) >= MAX_CONNECTIONS_PER_USER {
        return Err(AppError::TooManyRequests(
            "Too many open event streams for this account".to_string(),
        ));
    }

    // Ordinary requests are authorized once because they are over in
    // milliseconds. This one lives for as long as a tab stays open, so a single
    // check at the handshake would make it the one credential that outlives
    // "sign out everywhere" — the exact hole access-token revocation closed.
    // Keep the claims so the stream can re-check itself as it runs.
    let claims = session_claims(&req)?;

    let receiver = events::subscribe(user_id);
    let guard = ConnectionGuard {
        user_id,
        session_id: claims.sid,
        issued_at: claims.iat,
    };

    let body = stream::unfold((receiver, guard), |(mut receiver, guard)| async move {
        let next = tokio::time::timeout(KEEPALIVE_INTERVAL, receiver.recv()).await;

        // Checked on every wake-up, including keepalives, so a revoked session
        // is dropped within one keepalive interval at the latest rather than
        // whenever the client happens to reconnect.
        if revocation::is_revoked(guard.session_id, guard.user_id, guard.issued_at) {
            return None;
        }

        let chunk = match next {
            Ok(Ok(event)) => frame(event),
            // The connection fell behind its buffer. Say so rather than
            // resuming silently: the client has missed an unknown number
            // of hints, and the honest recovery is a full refetch, which
            // is what it does when it sees this.
            Ok(Err(RecvError::Lagged(missed))) => {
                log::debug!(
                    "event stream lagged user_id={} missed={missed}",
                    guard.user_id
                );
                ": lagged\n\n".to_string()
            }
            // Every sender is gone, which only happens at shutdown.
            Ok(Err(RecvError::Closed)) => return None,
            // Idle. A comment frame keeps proxies from reaping the
            // connection and lets the client tell alive from stalled.
            Err(_elapsed) => ": keepalive\n\n".to_string(),
        };

        Some((
            Ok::<_, actix_web::Error>(web::Bytes::from(chunk)),
            (receiver, guard),
        ))
    });

    Ok(HttpResponse::Ok()
        .content_type("text/event-stream")
        // `no-store` for the same reason every authenticated response carries
        // it; `no-transform` stops a CDN rewriting the body mid-stream.
        .insert_header(("Cache-Control", "no-store, no-transform"))
        // nginx buffers proxied responses by default, which would hold every
        // frame until the buffer filled — turning a push into a very slow poll.
        .insert_header(("X-Accel-Buffering", "no"))
        .streaming(body))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[actix_web::test]
    async fn an_open_stream_is_dropped_once_its_session_is_revoked() {
        // The property that makes a long-lived connection safe. Without it the
        // stream would be the one credential that survives "sign out
        // everywhere", because it is authorized once and then runs for hours.
        let user_id = Uuid::new_v4();
        let session_id = Uuid::new_v4();
        let issued_at = chrono::Utc::now().timestamp();

        assert!(!revocation::is_revoked(session_id, user_id, issued_at));
        revocation::revoke_session_in_memory(session_id);
        assert!(
            revocation::is_revoked(session_id, user_id, issued_at),
            "the stream's own liveness check must see the revocation"
        );
    }

    #[test]
    fn a_frame_is_well_formed_and_names_its_event() {
        let rendered = frame(UserEvent::MessagesChanged);
        assert_eq!(
            rendered,
            "event: messages\ndata: {\"kind\":\"messages\"}\n\n"
        );
        // The blank line is what terminates an SSE frame; without it the client
        // buffers indefinitely and nothing is ever delivered.
        assert!(rendered.ends_with("\n\n"));
    }

    #[test]
    fn frames_carry_no_content() {
        // The whole authorization argument rests on this: the payload names a
        // kind and nothing else. A future field carrying, say, a message body
        // would need every read-path rule re-checked here.
        for event in [UserEvent::MessagesChanged, UserEvent::NotificationsChanged] {
            let rendered = frame(event);
            assert!(rendered.contains(event.name()));
            assert_eq!(rendered.matches("data:").count(), 1);
            assert!(!rendered.contains("body"));
            assert!(!rendered.contains("username"));
        }
    }
}
