//! Instant access-token revocation.
//!
//! Access tokens are stateless: that is what makes them cheap, and it is also
//! what made "sign out everywhere" a promise this service could not keep.
//! Revoking a session revoked its refresh token, but an access token already
//! issued stayed valid until it expired — up to `JWT_EXPIRY_MINUTES` in which a
//! stolen credential still worked after the owner had done everything right.
//!
//! The fix keeps tokens stateless and adds one in-process lookup:
//!
//! * every access token carries a `sid` claim — the refresh token's
//!   `family_id`, the session identity that survives rotation;
//! * every revocation is written to `access_token_revocations` *and* mirrored
//!   into the cache below;
//! * `is_revoked` answers from memory, so the hot path costs no query.
//!
//! Durability matters here in a way it usually does not for a cache. If the
//! cache were the only record, restarting the process would silently un-revoke
//! every session revoked in the preceding few minutes — the failure would be
//! invisible and would happen exactly when an operator restarts after an
//! incident. The table is the source of truth; [`load`] rebuilds from it at
//! startup, before the listener accepts a single request.
//!
//! Nothing here grows without bound. A revocation only has to outlive the
//! longest access token it could affect, so entries expire after
//! [`REVOCATION_TTL`] and are dropped from both the cache and the table.

use std::collections::HashMap;
use std::sync::{LazyLock, RwLock};
use std::time::Duration;

use chrono::{DateTime, Timelike, Utc};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::errors::AppError;

/// How long a revocation is retained. Must exceed the longest access-token
/// lifetime the configuration permits: `jwt_expiry_minutes` is bounded to
/// 5..=60 in `config.rs`, so 60 minutes is the ceiling, plus a margin for the
/// validator's 5-second clock leeway and for a token minted moments before the
/// revocation landed. Beyond this window every affected token has expired on
/// its own and the record has no work left to do.
pub const REVOCATION_TTL: chrono::Duration = chrono::Duration::minutes(75);

/// How often expired entries are swept from the cache and the table.
const PRUNE_INTERVAL: Duration = Duration::from_secs(5 * 60);

/// The in-process view of `access_token_revocations`.
///
/// Split into two maps because the two lookups differ: a session revocation is
/// a set membership test, a user revocation is a comparison against a cutoff.
#[derive(Default)]
struct RevocationCache {
    /// `family_id` → when the entry may be forgotten.
    sessions: HashMap<Uuid, DateTime<Utc>>,
    /// `user_id` → (cutoff, when the entry may be forgotten). Every access
    /// token this user issued strictly before `cutoff` is refused.
    users: HashMap<Uuid, (DateTime<Utc>, DateTime<Utc>)>,
}

static CACHE: LazyLock<RwLock<RevocationCache>> =
    LazyLock::new(|| RwLock::new(RevocationCache::default()));

/// A poisoned lock means a writer panicked mid-update. The data behind it is a
/// set of revocations, and the safe reading of a possibly-torn revocation set
/// is "assume it is incomplete", never "assume it is empty". Recovering the
/// guard keeps the checks running on what we do have rather than panicking the
/// request; the alternative — treating a poisoned lock as "nothing is revoked"
/// — would turn a panic anywhere into an authentication bypass.
macro_rules! read_cache {
    () => {
        CACHE
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    };
}

macro_rules! write_cache {
    () => {
        CACHE
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    };
}

/// Is this session revoked?
///
/// `issued_at` is the token's `iat`, in whole seconds since the epoch, as JWT
/// defines it.
pub fn is_revoked(session_id: Uuid, user_id: Uuid, issued_at: i64) -> bool {
    let cache = read_cache!();
    let now = Utc::now();

    // An expired entry is treated as absent rather than as a miss to be
    // cleaned up here: the pruner owns removal, and the read path holds only a
    // shared lock.
    if let Some(expires_at) = cache.sessions.get(&session_id) {
        if *expires_at > now {
            return true;
        }
    }

    if let Some((cutoff, expires_at)) = cache.users.get(&user_id) {
        if *expires_at > now && issued_at < cutoff.timestamp() {
            return true;
        }
    }

    false
}

/// Revoke specific sessions, identified by refresh-token family.
///
/// Idempotent: re-revoking a session just refreshes its expiry.
pub async fn revoke_sessions(
    tx: &mut Transaction<'_, Postgres>,
    family_ids: &[Uuid],
) -> Result<(), AppError> {
    if family_ids.is_empty() {
        return Ok(());
    }

    let expires_at = Utc::now() + REVOCATION_TTL;
    // DISTINCT is load-bearing, not tidiness: `ON CONFLICT DO UPDATE` errors
    // with "cannot affect row a second time" if the same family appears twice
    // in one statement, which would turn a duplicate in the caller's list into
    // a failed revocation.
    sqlx::query(
        r#"INSERT INTO access_token_revocations (scope, subject_id, expires_at)
        SELECT DISTINCT 'session', family_id, $2
        FROM UNNEST($1::uuid[]) AS family_id
        ON CONFLICT (scope, subject_id) DO UPDATE
            SET revoked_at = NOW(), expires_at = EXCLUDED.expires_at"#,
    )
    .bind(family_ids)
    .bind(expires_at)
    .execute(&mut **tx)
    .await?;

    let mut cache = write_cache!();
    for family_id in family_ids {
        cache.sessions.insert(*family_id, expires_at);
    }

    Ok(())
}

/// Revoke every access token this account has issued up to now.
///
/// The cutoff is rounded *up* to the next whole second. `iat` is recorded in
/// whole seconds, so a token minted at 10:00:00.9 and a revocation at
/// 10:00:00.1 are indistinguishable by comparison alone. Rounding up refuses
/// everything issued during the revocation's own second, which can wrongly
/// refuse a token minted later in that same second; rounding down would instead
/// let a token issued earlier in it survive. For a control whose whole purpose
/// is to cut off a credential, refusing one token too many is the correct way
/// to be wrong — and the client recovers by re-authenticating, which is what a
/// user who just pressed "sign out everywhere" is about to do anyway.
pub async fn revoke_user(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
) -> Result<(), AppError> {
    let now = Utc::now();
    let cutoff = now
        .checked_add_signed(chrono::Duration::seconds(1))
        .unwrap_or(now)
        .with_nanosecond(0)
        .unwrap_or(now);
    let expires_at = now + REVOCATION_TTL;

    sqlx::query(
        r#"INSERT INTO access_token_revocations (scope, subject_id, revoked_at, expires_at)
        VALUES ('user', $1, $2, $3)
        ON CONFLICT (scope, subject_id) DO UPDATE
            SET revoked_at = GREATEST(access_token_revocations.revoked_at, EXCLUDED.revoked_at),
                expires_at = GREATEST(access_token_revocations.expires_at, EXCLUDED.expires_at)"#,
    )
    .bind(user_id)
    .bind(cutoff)
    .bind(expires_at)
    .execute(&mut **tx)
    .await?;

    let mut cache = write_cache!();
    cache
        .users
        .entry(user_id)
        // A later revocation must never move the cutoff backwards, or a token
        // the earlier one refused would start being accepted again.
        .and_modify(|entry| {
            entry.0 = entry.0.max(cutoff);
            entry.1 = entry.1.max(expires_at);
        })
        .or_insert((cutoff, expires_at));

    Ok(())
}

/// Rebuild the cache from the table. Call once at startup, before serving.
///
/// Returns the number of live revocations loaded.
pub async fn load(pool: &PgPool) -> Result<usize, AppError> {
    // Sweep first so the rebuild does not carry forward entries that are
    // already dead — otherwise a long outage would repopulate the cache with
    // revocations whose tokens expired while the process was down.
    prune(pool).await?;

    let sessions = sqlx::query_as::<_, (Uuid, DateTime<Utc>)>(
        "SELECT subject_id, expires_at FROM access_token_revocations WHERE scope = 'session'",
    )
    .fetch_all(pool)
    .await?;
    let users = sqlx::query_as::<_, (Uuid, DateTime<Utc>, DateTime<Utc>)>(
        "SELECT subject_id, revoked_at, expires_at FROM access_token_revocations WHERE scope = 'user'",
    )
    .fetch_all(pool)
    .await?;

    let total = sessions.len() + users.len();
    let mut cache = write_cache!();
    cache.sessions = sessions.into_iter().collect();
    cache.users = users
        .into_iter()
        .map(|(user_id, cutoff, expires_at)| (user_id, (cutoff, expires_at)))
        .collect();

    Ok(total)
}

/// Drop expired entries from the table and the cache.
pub async fn prune(pool: &PgPool) -> Result<u64, AppError> {
    let deleted = sqlx::query("DELETE FROM access_token_revocations WHERE expires_at <= NOW()")
        .execute(pool)
        .await?
        .rows_affected();

    let now = Utc::now();
    let mut cache = write_cache!();
    cache.sessions.retain(|_, expires_at| *expires_at > now);
    cache.users.retain(|_, (_, expires_at)| *expires_at > now);

    Ok(deleted)
}

/// Seed the cache directly, without a database, so tests elsewhere in the
/// crate can exercise code paths that depend on a session being revoked.
#[cfg(test)]
pub(crate) fn revoke_session_in_memory(family_id: Uuid) {
    write_cache!()
        .sessions
        .insert(family_id, Utc::now() + REVOCATION_TTL);
}

/// Empty the cache without touching the table, so an integration test can
/// simulate a process restart and prove that [`load`] puts the revocations back.
///
/// Not `#[cfg(test)]`: integration tests link the library compiled without it,
/// and the restart path is precisely the one that would fail silently — an
/// operator restarting after an incident would un-revoke the sessions they had
/// just cut off, with nothing in the logs to say so. Covering it is worth this
/// small hole in the API surface. Never call it from serving code.
#[doc(hidden)]
pub fn clear_cache_for_test() {
    let mut cache = write_cache!();
    cache.sessions.clear();
    cache.users.clear();
}

/// Sweep expired revocations on a timer for the lifetime of the process.
pub fn start_pruner(pool: PgPool) {
    actix_web::rt::spawn(async move {
        let mut interval = tokio::time::interval(PRUNE_INTERVAL);
        // Startup already performs an explicit sweep through `load`.
        interval.tick().await;
        loop {
            interval.tick().await;
            match prune(&pool).await {
                Ok(0) => {}
                Ok(deleted) => log::debug!("Pruned {deleted} expired access-token revocation(s)"),
                Err(error) => log::error!("Failed to prune access-token revocations: {error}"),
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    // These tests share one process-global cache and cargo runs them in
    // parallel, so none of them may clear it: wiping the map would delete the
    // entries a concurrently running test had just inserted, which is exactly
    // how this suite first went flaky. Isolation comes from every test using
    // freshly generated UUIDs instead, so no two ever address the same key.

    fn insert_session(family_id: Uuid, expires_at: DateTime<Utc>) {
        write_cache!().sessions.insert(family_id, expires_at);
    }

    fn insert_user(user_id: Uuid, cutoff: DateTime<Utc>, expires_at: DateTime<Utc>) {
        write_cache!().users.insert(user_id, (cutoff, expires_at));
    }

    #[test]
    fn an_unknown_session_is_not_revoked() {
        assert!(!is_revoked(
            Uuid::new_v4(),
            Uuid::new_v4(),
            Utc::now().timestamp()
        ));
    }

    #[test]
    fn a_revoked_session_is_refused() {
        let family_id = Uuid::new_v4();
        insert_session(family_id, Utc::now() + chrono::Duration::minutes(30));

        assert!(is_revoked(
            family_id,
            Uuid::new_v4(),
            Utc::now().timestamp()
        ));
    }

    #[test]
    fn revoking_one_session_leaves_the_others_alone() {
        let revoked = Uuid::new_v4();
        let untouched = Uuid::new_v4();
        let user_id = Uuid::new_v4();
        insert_session(revoked, Utc::now() + chrono::Duration::minutes(30));

        assert!(is_revoked(revoked, user_id, Utc::now().timestamp()));
        assert!(!is_revoked(untouched, user_id, Utc::now().timestamp()));
    }

    #[test]
    fn an_expired_session_entry_stops_refusing() {
        let family_id = Uuid::new_v4();
        // Already past: every token it could have covered has expired too.
        insert_session(family_id, Utc::now() - chrono::Duration::seconds(1));

        assert!(!is_revoked(
            family_id,
            Uuid::new_v4(),
            Utc::now().timestamp()
        ));
    }

    #[test]
    fn a_user_cutoff_refuses_only_tokens_issued_before_it() {
        let user_id = Uuid::new_v4();
        let cutoff = Utc::now();
        insert_user(user_id, cutoff, Utc::now() + chrono::Duration::minutes(30));

        // Issued a minute before the cutoff: refused.
        assert!(is_revoked(
            Uuid::new_v4(),
            user_id,
            (cutoff - chrono::Duration::minutes(1)).timestamp()
        ));
        // Issued a minute after: this is a fresh sign-in, and it must work.
        assert!(!is_revoked(
            Uuid::new_v4(),
            user_id,
            (cutoff + chrono::Duration::minutes(1)).timestamp()
        ));
    }

    #[test]
    fn a_user_cutoff_does_not_touch_other_accounts() {
        let revoked_user = Uuid::new_v4();
        let other_user = Uuid::new_v4();
        let cutoff = Utc::now();
        insert_user(
            revoked_user,
            cutoff,
            Utc::now() + chrono::Duration::minutes(30),
        );

        let issued_at = (cutoff - chrono::Duration::minutes(1)).timestamp();
        assert!(is_revoked(Uuid::new_v4(), revoked_user, issued_at));
        assert!(!is_revoked(Uuid::new_v4(), other_user, issued_at));
    }

    #[test]
    fn an_expired_user_entry_stops_refusing() {
        let user_id = Uuid::new_v4();
        let cutoff = Utc::now();
        insert_user(user_id, cutoff, Utc::now() - chrono::Duration::seconds(1));

        assert!(!is_revoked(
            Uuid::new_v4(),
            user_id,
            (cutoff - chrono::Duration::minutes(1)).timestamp()
        ));
    }

    #[test]
    fn pruning_the_cache_drops_only_expired_entries() {
        let live_session = Uuid::new_v4();
        let dead_session = Uuid::new_v4();
        let live_user = Uuid::new_v4();
        let dead_user = Uuid::new_v4();
        let cutoff = Utc::now();

        insert_session(live_session, Utc::now() + chrono::Duration::minutes(30));
        insert_session(dead_session, Utc::now() - chrono::Duration::seconds(1));
        insert_user(
            live_user,
            cutoff,
            Utc::now() + chrono::Duration::minutes(30),
        );
        insert_user(dead_user, cutoff, Utc::now() - chrono::Duration::seconds(1));

        // The database half needs a pool; exercise the in-memory half directly.
        let now = Utc::now();
        {
            let mut cache = write_cache!();
            cache.sessions.retain(|_, expires_at| *expires_at > now);
            cache.users.retain(|_, (_, expires_at)| *expires_at > now);
        }

        let cache = read_cache!();
        assert!(cache.sessions.contains_key(&live_session));
        assert!(!cache.sessions.contains_key(&dead_session));
        assert!(cache.users.contains_key(&live_user));
        assert!(!cache.users.contains_key(&dead_user));
    }

    #[test]
    fn the_retention_window_outlives_the_longest_possible_access_token() {
        // config.rs bounds JWT_EXPIRY_MINUTES to 5..=60. If that ceiling ever
        // rises above this window, a revocation would expire while tokens it
        // was meant to refuse are still valid.
        assert!(REVOCATION_TTL > chrono::Duration::minutes(60));
    }
}
