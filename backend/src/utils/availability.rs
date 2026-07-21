/// The latest date that is still "today" somewhere on earth (UTC+14).
///
/// Episode availability is checked against this instead of the server's own
/// `CURRENT_DATE`. The calendar lists episodes using the date the *device*
/// reports, so between the server's midnight and the user's there is a window
/// where an episode plainly listed as airing today is refused as a future
/// episode. For Romania in summer that is roughly 21:00–24:00 UTC, and inside
/// it the refusal looks arbitrary rather than principled.
///
/// Being generous by up to fourteen hours only ever admits an episode that has
/// already aired for somebody. It is deliberately not driven by a client-sent
/// date: that would let any caller claim tomorrow and mark unaired episodes
/// watched, which is the exact thing the guard exists to prevent.
///
/// This is a macro rather than a `const` so it can sit inside `concat!` next to
/// the surrounding SQL, keeping the queries as plain string literals with no
/// runtime formatting.
#[macro_export]
macro_rules! available_through {
    () => {
        "((NOW() AT TIME ZONE 'UTC') + INTERVAL '14 hours')::date"
    };
}
