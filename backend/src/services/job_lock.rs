//! Run-wide exclusivity for the background jobs.
//!
//! Each job runs for as long as its upstream requests take, and two overlapping
//! runs would only double the load on the API key the whole application shares.
//! They used to take `pg_try_advisory_xact_lock` inside a transaction that then
//! sat open, and idle, for the entire run while the real work went through other
//! connections. Since every role got `idle_in_transaction_session_timeout = 60s`
//! (`scripts/provision_db_role.sh`), Postgres ends that transaction a minute in,
//! and any run longer than a minute failed with "Database error" at the end.
//! Catalog hydration, whose runs take minutes, could not finish at all; the
//! release worker failed only on its longer runs.
//!
//! The lock is now session-level, on a connection of its own that is never in
//! a transaction, so the idle-in-transaction timeout does not apply to it. The
//! connection is detached from the pool: when a run ends early on an error and
//! the guard is dropped without `release`, the connection closes and Postgres
//! drops the lock with the session, the same guarantee the transaction gave.

use sqlx::{Connection, PgConnection, PgPool};

pub struct JobLock {
    connection: PgConnection,
    key: i64,
}

impl JobLock {
    /// Takes the lock, or returns `None` when another run already holds it.
    pub async fn try_acquire(pool: &PgPool, key: i64) -> Result<Option<Self>, sqlx::Error> {
        let mut connection = pool.acquire().await?.detach();
        let acquired = sqlx::query_scalar::<_, bool>("SELECT pg_try_advisory_lock($1)")
            .bind(key)
            .fetch_one(&mut connection)
            .await?;
        if !acquired {
            connection.close().await?;
            return Ok(None);
        }
        Ok(Some(Self { connection, key }))
    }

    /// Releases the lock and closes its connection.
    pub async fn release(mut self) -> Result<(), sqlx::Error> {
        sqlx::query("SELECT pg_advisory_unlock($1)")
            .bind(self.key)
            .execute(&mut self.connection)
            .await?;
        self.connection.close().await
    }
}
