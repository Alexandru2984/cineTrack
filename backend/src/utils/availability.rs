//! When an episode counts as having aired.
//!
//! # The problem with `air_date`
//!
//! It is a bare `DATE`, and it means one specific thing: the local calendar
//! date on which the episode first went out on its *origin* network. No time,
//! no zone. A US drama broadcast on Sunday at 21:00 Eastern carries the
//! Sunday date, and that same episode reaches Romania on Monday at 04:00.
//!
//! Treating that date as "available from its own midnight" is therefore wrong
//! by most of a day, in the direction that matters: it promises something the
//! viewer cannot watch yet.
//!
//! # The rule
//!
//! An episode has aired once its air date has **fully elapsed in UTC**.
//!
//! That sounds arbitrary and is not. For prime-time US television — which is
//! most of what carries a lagging international release — the end of the air
//! date in UTC falls at 20:00 Eastern, within an hour of the broadcast itself.
//! A viewer in Romania reaches it at 03:00, an hour before the Max release
//! rather than thirty-nine hours before it.
//!
//! It is deliberately a rule about *when*, not about *where*. A per-viewer
//! answer would need a per-country release time for each episode, and no
//! provider publishes one for television. Guessing per region would replace a
//! known error of about an hour with an unknown error nobody could audit.
//!
//! # Why not the viewer's own date
//!
//! Up Next used to bound this with the date the client reported. That is worse
//! twice over: it is a value the caller chooses, so it decides what counts as
//! aired; and a client one time zone east of the origin network calls an
//! episode current a full day before it exists.

/// The latest air date that has fully elapsed, as SQL.
///
/// A macro rather than a `const` so it can sit inside `concat!` beside the
/// surrounding SQL, keeping queries as plain string literals with no runtime
/// formatting.
///
/// Must stay equal to [`aired_through`]. Some checks run in Rust before their
/// query, and a disagreement would reject exactly the episodes the query is
/// willing to accept. `sql_and_rust_agree_on_the_cutoff` holds them together.
#[macro_export]
macro_rules! aired_through {
    () => {
        "((NOW() AT TIME ZONE 'UTC')::date - 1)"
    };
}

/// The latest air date that has fully elapsed, in Rust.
///
/// See [`aired_through!`] for the rule and why the two exist.
pub fn aired_through() -> chrono::NaiveDate {
    chrono::Utc::now().date_naive() - chrono::Duration::days(1)
}
