use std::time::Duration;

use sqlx::PgPool;

const PRUNE_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Debug, Default, PartialEq, Eq)]
pub struct RetentionSummary {
    pub refresh_tokens: u64,
    pub password_reset_tokens: u64,
    pub email_verification_tokens: u64,
    pub email_change_tokens: u64,
    pub security_activity: u64,
    pub moderation_audit: u64,
    pub resolved_reports: u64,
}

impl RetentionSummary {
    pub fn total(&self) -> u64 {
        self.refresh_tokens
            + self.password_reset_tokens
            + self.email_verification_tokens
            + self.email_change_tokens
            + self.security_activity
            + self.moderation_audit
            + self.resolved_reports
    }
}

/// Remove security artifacts after they can no longer be used.
///
/// Refresh-token history is retained while any token in the same rotation
/// family remains active. That history is required to detect replay of a
/// consumed token and revoke the whole family. Consumed/revoked artifacts get
/// a short forensic window; expired, fully inactive refresh families can be
/// removed immediately.
pub async fn prune_security_artifacts(pool: &PgPool) -> Result<RetentionSummary, sqlx::Error> {
    let mut tx = pool.begin().await?;

    let refresh_tokens = sqlx::query(
        r#"DELETE FROM refresh_tokens
        WHERE (
            expires_at < NOW()
            OR (consumed_at IS NOT NULL AND consumed_at < NOW() - INTERVAL '7 days')
            OR (revoked_at IS NOT NULL AND revoked_at < NOW() - INTERVAL '7 days')
        )
        AND NOT EXISTS (
            SELECT 1 FROM refresh_tokens active
            WHERE active.family_id = refresh_tokens.family_id
              AND active.consumed_at IS NULL
              AND active.revoked_at IS NULL
              AND active.expires_at >= NOW()
        )"#,
    )
    .execute(&mut *tx)
    .await?
    .rows_affected();

    let password_reset_tokens = sqlx::query(
        r#"DELETE FROM password_reset_tokens
        WHERE (consumed_at IS NOT NULL AND consumed_at < NOW() - INTERVAL '7 days')
           OR (consumed_at IS NULL AND expires_at < NOW() - INTERVAL '7 days')"#,
    )
    .execute(&mut *tx)
    .await?
    .rows_affected();

    let email_verification_tokens = sqlx::query(
        r#"DELETE FROM email_verification_tokens
        WHERE (consumed_at IS NOT NULL AND consumed_at < NOW() - INTERVAL '7 days')
           OR (consumed_at IS NULL AND expires_at < NOW() - INTERVAL '7 days')"#,
    )
    .execute(&mut *tx)
    .await?
    .rows_affected();

    let email_change_tokens = sqlx::query(
        r#"DELETE FROM email_change_tokens
        WHERE (consumed_at IS NOT NULL AND consumed_at < NOW() - INTERVAL '7 days')
           OR (consumed_at IS NULL AND expires_at < NOW() - INTERVAL '7 days')"#,
    )
    .execute(&mut *tx)
    .await?
    .rows_affected();

    let security_activity = sqlx::query(
        "DELETE FROM security_activity
         WHERE created_at < NOW() - INTERVAL '90 days'",
    )
    .execute(&mut *tx)
    .await?
    .rows_affected();

    // Community reports may contain a server-side evidence snapshot and
    // moderator notes. Active reports are retained until resolved; closed
    // cases and their audit trail receive a two-year accountability window.
    let (moderation_audit, resolved_reports) =
        sqlx::query_as::<_, (i64, i64)>("SELECT * FROM prune_old_moderation_records()")
            .fetch_one(&mut *tx)
            .await?;

    tx.commit().await?;

    Ok(RetentionSummary {
        refresh_tokens,
        password_reset_tokens,
        email_verification_tokens,
        email_change_tokens,
        security_activity,
        moderation_audit: moderation_audit.max(0) as u64,
        resolved_reports: resolved_reports.max(0) as u64,
    })
}

pub fn start_security_artifact_pruner(pool: PgPool) {
    actix_web::rt::spawn(async move {
        let mut interval = tokio::time::interval(PRUNE_INTERVAL);
        // Startup performs an explicit sweep; wait one full interval here.
        interval.tick().await;

        loop {
            interval.tick().await;
            match prune_security_artifacts(&pool).await {
                Ok(summary) if summary.total() > 0 => log::info!(
                    "Pruned security artifacts: refresh_tokens={} password_reset_tokens={} \
                     email_verification_tokens={} email_change_tokens={} security_activity={} \
                     moderation_audit={} resolved_reports={}",
                    summary.refresh_tokens,
                    summary.password_reset_tokens,
                    summary.email_verification_tokens,
                    summary.email_change_tokens,
                    summary.security_activity,
                    summary.moderation_audit,
                    summary.resolved_reports,
                ),
                Ok(_) => {}
                Err(error) => log::error!("Failed to prune security artifacts: {error}"),
            }
        }
    });
}
