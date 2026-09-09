//! Shared retry policy for the two jobs that refresh titles from TMDB.
//!
//! `catalog_hydration` and `release_schedule` walk different candidate sets for
//! different reasons, but they meet the same upstream and answer its failures
//! the same way: decide what kind of failure it was, record it, and choose when
//! to come back. Both carried their own byte-identical copy of that policy —
//! the same `retry_delay`, the same match arms over `AppError`, and the same
//! unit test asserting the same bounds.
//!
//! Two copies of a policy are not two implementations; they are one that has
//! not drifted yet. The failure it invites is quiet: a new `AppError` variant
//! classified as transient in one job and invalid in the other means the same
//! upstream problem is retried in an hour here and in a month there, and
//! nothing fails to make that visible.

use crate::errors::AppError;

/// What a failed refresh was, once the fatal cases have been ruled out.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RefreshOutcome {
    /// Upstream says the title does not exist. Retried, but rarely.
    NotFound,
    /// Upstream is unwell — down, rate limiting, or answering badly. The run
    /// stops rather than spending its remaining budget on the same failure.
    Transient,
    /// The answer arrived and could not be used. Retried rarely, like a miss.
    Invalid,
}

impl RefreshOutcome {
    /// The value stored in the `outcome` column, and the key `retry_delay` reads.
    pub fn label(self) -> &'static str {
        match self {
            RefreshOutcome::NotFound => "not_found",
            RefreshOutcome::Transient => "transient",
            RefreshOutcome::Invalid => "invalid",
        }
    }

    /// Whether meeting this ends the run. Only an unwell upstream does: the
    /// next candidate would meet the same wall, and the budget is better kept.
    pub fn stops_the_run(self) -> bool {
        matches!(self, RefreshOutcome::Transient)
    }
}

/// Sort a refresh failure into an outcome, or hand back the ones that are ours.
///
/// A database or internal error is not something the candidate did wrong, and
/// recording it against the title would blame the title for our own fault —
/// and then back it off for a month. Those propagate and fail the run instead.
pub fn classify(error: AppError) -> Result<RefreshOutcome, AppError> {
    match error {
        error @ (AppError::DatabaseError(_) | AppError::InternalError(_)) => Err(error),
        AppError::NotFound(_) => Ok(RefreshOutcome::NotFound),
        AppError::ServiceUnavailable(_) | AppError::TooManyRequests(_) | AppError::TmdbError(_) => {
            Ok(RefreshOutcome::Transient)
        }
        _ => Ok(RefreshOutcome::Invalid),
    }
}

/// How long to wait before trying this candidate again.
///
/// Exponential in the number of consecutive failures, capped so a title that
/// has failed many times is still retried eventually: a day for something
/// upstream is having trouble with, a month for one that looks genuinely gone.
pub fn retry_delay(outcome: &str, previous_failures: i16) -> chrono::Duration {
    let exponent = u32::from(previous_failures.clamp(0, 5) as u16);
    let multiplier = i64::from(1_u32 << exponent);
    match outcome {
        "transient" => chrono::Duration::hours(multiplier.min(24)),
        "not_found" | "invalid" => chrono::Duration::days(multiplier.min(30)),
        _ => chrono::Duration::days(1),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_backoff_is_bounded() {
        assert_eq!(retry_delay("transient", 0), chrono::Duration::hours(1));
        assert_eq!(retry_delay("transient", 8), chrono::Duration::hours(24));
        assert_eq!(retry_delay("not_found", 2), chrono::Duration::days(4));
        assert_eq!(retry_delay("invalid", 8), chrono::Duration::days(30));
        assert_eq!(retry_delay("invalid", 12), chrono::Duration::days(30));
    }

    #[test]
    fn a_negative_failure_count_does_not_shorten_the_wait() {
        // `consecutive_failures` is a smallint read back from the database, so
        // the type permits a negative the column should never hold. Clamping
        // means it backs off like a first failure rather than shifting by a
        // huge exponent.
        assert_eq!(retry_delay("transient", -3), chrono::Duration::hours(1));
    }

    #[test]
    fn an_unknown_outcome_backs_off_a_day() {
        assert_eq!(retry_delay("something_else", 4), chrono::Duration::days(1));
    }

    #[test]
    fn our_own_failures_are_not_blamed_on_the_title() {
        // A database error must come back out rather than being recorded
        // against the candidate — which would back off a healthy title for a
        // month because our own connection dropped.
        let error = AppError::InternalError(anyhow::anyhow!("boom"));
        assert!(classify(error).is_err());
    }

    #[test]
    fn upstream_trouble_stops_the_run_and_a_bad_answer_does_not() {
        let unwell = classify(AppError::TooManyRequests("slow down".into())).expect("classified");
        assert_eq!(unwell, RefreshOutcome::Transient);
        assert_eq!(unwell.label(), "transient");
        assert!(unwell.stops_the_run());

        let missing = classify(AppError::NotFound("gone".into())).expect("classified");
        assert_eq!(missing.label(), "not_found");
        assert!(!missing.stops_the_run());

        let unusable = classify(AppError::BadRequest("nonsense".into())).expect("classified");
        assert_eq!(unusable, RefreshOutcome::Invalid);
        assert_eq!(unusable.label(), "invalid");
        assert!(!unusable.stops_the_run());
    }
}
