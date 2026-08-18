//! In-process fan-out of "something you care about changed" signals.
//!
//! Every client polls today: an open message thread every ten seconds, the
//! conversation list every twenty, notifications every thirty. Almost all of
//! those requests answer "nothing new" — they cost a database round trip each,
//! they keep phone radios awake, and the cost grows with the number of open
//! tabs rather than with the amount of activity.
//!
//! # The events carry no content
//!
//! A subscriber is told only *that* its messages or notifications changed, and
//! refetches through the ordinary authenticated endpoint. Pushing the message
//! body would mean re-implementing, on the push path, every rule the read path
//! already enforces — blocks, mutual-follow, verification, terms. Those rules
//! change; a second copy of them would drift, and the failure mode is delivering
//! private content to somebody who should no longer see it. Signalling instead
//! keeps exactly one authorization path.
//!
//! It also makes delivery failure harmless. A dropped signal costs a delayed
//! refresh, not a lost message, so this can stay best-effort and lock-free
//! rather than becoming a queue that has to be durable.
//!
//! # Scope
//!
//! Deliberately in-process, matching the single backend process this deployment
//! runs (see the import-recovery note in `main.rs`). Introducing Redis to relay
//! a hint that costs one refetch to recover would add a component that can fail
//! on its own.

use std::collections::HashMap;
use std::sync::{LazyLock, RwLock};

use serde::Serialize;
use tokio::sync::broadcast;
use uuid::Uuid;

/// How many undelivered signals a single connection may fall behind by.
///
/// Small on purpose. These are hints, and a slow consumer that misses some has
/// missed nothing it cannot recover by refetching once — which is precisely
/// what it does when it notices the gap.
const CHANNEL_CAPACITY: usize = 16;

/// What changed. No identifiers, no content: see the module note.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum UserEvent {
    /// A direct message was sent to, or read by, this user.
    MessagesChanged,
    /// A notification was created for this user.
    NotificationsChanged,
}

impl UserEvent {
    /// The SSE `event:` name, so a client can add a listener per kind instead
    /// of parsing every payload.
    pub const fn name(self) -> &'static str {
        match self {
            Self::MessagesChanged => "messages",
            Self::NotificationsChanged => "notifications",
        }
    }
}

/// One channel per user with at least one live connection.
///
/// A `broadcast` sender with no receivers is not an error here — publishing to
/// an absent user is the common case (they are offline) and must be free.
static CHANNELS: LazyLock<RwLock<HashMap<Uuid, broadcast::Sender<UserEvent>>>> =
    LazyLock::new(|| RwLock::new(HashMap::new()));

/// A poisoned lock means a writer panicked mid-update. Recovering the guard
/// keeps the fan-out working on what is there; the worst case is a missed hint,
/// which the next reconnect repairs. Panicking a request over a best-effort
/// notification would be the larger bug.
macro_rules! channels_read {
    () => {
        CHANNELS
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    };
}

macro_rules! channels_write {
    () => {
        CHANNELS
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    };
}

/// Tell every live connection for this user that something changed.
///
/// Never fails and never blocks. If the user has no connection, or every
/// connection is lagging, the signal is dropped: it carries no information that
/// is not already in the database.
pub fn publish(user_id: Uuid, event: UserEvent) {
    let sender = channels_read!().get(&user_id).cloned();
    if let Some(sender) = sender {
        // `Err` only means "nobody listening any more"; `release` removes the
        // entry, and until then a send that reaches no one is the intended no-op.
        let _ = sender.send(event);
    }
}

/// Subscribe to this user's signals for the lifetime of one connection.
pub fn subscribe(user_id: Uuid) -> broadcast::Receiver<UserEvent> {
    // Fast path first: an existing channel needs only a read lock, and most
    // subscriptions join one (a user with a phone and a laptop open).
    if let Some(sender) = channels_read!().get(&user_id) {
        return sender.subscribe();
    }

    let mut channels = channels_write!();
    // Re-check under the write lock: another connection for the same user may
    // have created the channel between the two locks.
    channels
        .entry(user_id)
        .or_insert_with(|| broadcast::channel(CHANNEL_CAPACITY).0)
        .subscribe()
}

/// How many connections this user currently has, used to bound them.
pub fn connection_count(user_id: Uuid) -> usize {
    channels_read!()
        .get(&user_id)
        .map_or(0, broadcast::Sender::receiver_count)
}

/// Drop channels nobody is listening to.
///
/// Called when a connection ends. Without it the map would keep one entry per
/// user who has ever connected — small, but unbounded in the number of accounts,
/// which is the shape of leak that only shows up once the service is popular.
pub fn release(user_id: Uuid) {
    let mut channels = channels_write!();
    if channels
        .get(&user_id)
        .is_some_and(|sender| sender.receiver_count() == 0)
    {
        channels.remove(&user_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Every test uses freshly generated user ids, so they stay independent
    // while sharing the process-global map. Nothing here may clear it.

    #[tokio::test]
    async fn a_subscriber_receives_a_published_event() {
        let user_id = Uuid::new_v4();
        let mut receiver = subscribe(user_id);

        publish(user_id, UserEvent::MessagesChanged);

        assert_eq!(receiver.recv().await.unwrap(), UserEvent::MessagesChanged);
        release(user_id);
    }

    #[tokio::test]
    async fn every_connection_for_one_user_receives_the_event() {
        // Two devices, one account: both have to wake up.
        let user_id = Uuid::new_v4();
        let mut phone = subscribe(user_id);
        let mut laptop = subscribe(user_id);

        publish(user_id, UserEvent::NotificationsChanged);

        assert_eq!(phone.recv().await.unwrap(), UserEvent::NotificationsChanged);
        assert_eq!(
            laptop.recv().await.unwrap(),
            UserEvent::NotificationsChanged
        );
        release(user_id);
    }

    #[tokio::test]
    async fn events_are_not_delivered_to_another_account() {
        let listener = Uuid::new_v4();
        let stranger = Uuid::new_v4();
        let mut receiver = subscribe(listener);

        publish(stranger, UserEvent::MessagesChanged);

        assert!(
            receiver.try_recv().is_err(),
            "an event reached an account it was not addressed to"
        );
        release(listener);
        release(stranger);
    }

    #[test]
    fn publishing_to_an_absent_user_is_a_no_op() {
        // The common case: the recipient is offline. It must not allocate a
        // channel, or the map would grow with every message ever sent.
        let user_id = Uuid::new_v4();
        publish(user_id, UserEvent::MessagesChanged);
        assert_eq!(connection_count(user_id), 0);
        assert!(!channels_read!().contains_key(&user_id));
    }

    #[tokio::test]
    async fn releasing_the_last_connection_drops_the_channel() {
        let user_id = Uuid::new_v4();
        let receiver = subscribe(user_id);
        assert_eq!(connection_count(user_id), 1);

        drop(receiver);
        release(user_id);

        assert!(!channels_read!().contains_key(&user_id));
    }

    #[tokio::test]
    async fn releasing_one_of_two_connections_keeps_the_channel() {
        let user_id = Uuid::new_v4();
        let first = subscribe(user_id);
        let second = subscribe(user_id);

        drop(first);
        release(user_id);

        assert_eq!(connection_count(user_id), 1);
        drop(second);
        release(user_id);
    }

    #[tokio::test]
    async fn a_lagging_connection_is_told_it_fell_behind() {
        // The contract the client depends on: overflow surfaces as Lagged
        // rather than silently skipping, so the client knows to refetch.
        let user_id = Uuid::new_v4();
        let mut receiver = subscribe(user_id);
        for _ in 0..(CHANNEL_CAPACITY + 4) {
            publish(user_id, UserEvent::MessagesChanged);
        }

        assert!(matches!(
            receiver.recv().await,
            Err(broadcast::error::RecvError::Lagged(_))
        ));
        release(user_id);
    }

    #[test]
    fn event_names_are_distinct_and_stable() {
        // Clients add listeners by name; a collision would deliver one kind to
        // the other's handler.
        assert_eq!(UserEvent::MessagesChanged.name(), "messages");
        assert_eq!(UserEvent::NotificationsChanged.name(), "notifications");
    }
}
