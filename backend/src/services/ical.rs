//! Minimal RFC 5545 iCalendar writer for the subscribable feed. Only what the
//! feed needs: all-day VEVENTs with escaping and 75-octet line folding.

use chrono::{DateTime, Duration, NaiveDate, Utc};

const PRODID: &str = "-//Vazute//Calendar Feed//EN";

/// One all-day calendar entry (an upcoming episode air date).
pub struct FeedEvent {
    /// Globally unique, stable across refreshes (episode id + a domain).
    pub uid: String,
    pub date: NaiveDate,
    pub summary: String,
    pub description: Option<String>,
}

/// Render a full VCALENDAR document with CRLF line endings.
pub fn build_calendar(calendar_name: &str, events: &[FeedEvent], now: DateTime<Utc>) -> String {
    let stamp = now.format("%Y%m%dT%H%M%SZ").to_string();
    let mut lines = vec![
        "BEGIN:VCALENDAR".to_string(),
        "VERSION:2.0".to_string(),
        format!("PRODID:{PRODID}"),
        "CALSCALE:GREGORIAN".to_string(),
        "METHOD:PUBLISH".to_string(),
        format!("X-WR-CALNAME:{}", escape_text(calendar_name)),
    ];

    for event in events {
        // All-day event: DTEND is exclusive, so the day after the air date.
        let end = event.date + Duration::days(1);
        lines.push("BEGIN:VEVENT".to_string());
        lines.push(format!("UID:{}", escape_text(&event.uid)));
        lines.push(format!("DTSTAMP:{stamp}"));
        lines.push(format!("DTSTART;VALUE=DATE:{}", event.date.format("%Y%m%d")));
        lines.push(format!("DTEND;VALUE=DATE:{}", end.format("%Y%m%d")));
        lines.push(format!("SUMMARY:{}", escape_text(&event.summary)));
        if let Some(description) = event
            .description
            .as_deref()
            .filter(|value| !value.is_empty())
        {
            lines.push(format!("DESCRIPTION:{}", escape_text(description)));
        }
        lines.push("END:VEVENT".to_string());
    }

    lines.push("END:VCALENDAR".to_string());

    let mut output = String::new();
    for line in lines {
        output.push_str(&fold_line(&line));
        output.push_str("\r\n");
    }
    output
}

/// Escape a TEXT value per RFC 5545 §3.3.11.
fn escape_text(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            ';' => out.push_str("\\;"),
            ',' => out.push_str("\\,"),
            '\n' => out.push_str("\\n"),
            '\r' => {}
            _ => out.push(ch),
        }
    }
    out
}

/// Fold a content line to at most 75 octets, continuation lines beginning with
/// a single space (RFC 5545 §3.1). Splits on char boundaries so a multi-byte
/// character is never cut.
fn fold_line(line: &str) -> String {
    if line.len() <= 75 {
        return line.to_string();
    }
    let mut out = String::new();
    let mut line_len = 0_usize;
    let mut first = true;
    for ch in line.chars() {
        let ch_len = ch.len_utf8();
        // First line budgets 75 octets; continuation lines spend one on the
        // leading space, leaving 74 for content.
        let budget = if first { 75 } else { 74 };
        if line_len + ch_len > budget {
            out.push_str("\r\n ");
            line_len = 0;
            first = false;
        }
        out.push(ch);
        line_len += ch_len;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-07-26T10:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn escapes_special_characters() {
        assert_eq!(escape_text("a,b;c\\d"), "a\\,b\\;c\\\\d");
        assert_eq!(escape_text("line1\nline2"), "line1\\nline2");
        assert_eq!(escape_text("drop\rcr"), "dropcr");
    }

    #[test]
    fn folds_long_lines_to_75_octets() {
        let long = format!("SUMMARY:{}", "x".repeat(200));
        let folded = fold_line(&long);
        for (index, segment) in folded.split("\r\n").enumerate() {
            assert!(
                segment.len() <= 75,
                "segment {index} is {} octets",
                segment.len()
            );
            if index > 0 {
                assert!(segment.starts_with(' '), "continuation must start with a space");
            }
        }
        // Unfolding (strip CRLF + leading space) restores the original.
        assert_eq!(folded.replace("\r\n ", ""), long);
    }

    #[test]
    fn builds_a_wellformed_all_day_event() {
        let events = vec![FeedEvent {
            uid: "ep-1@vazute".to_string(),
            date: NaiveDate::from_ymd_opt(2026, 8, 1).unwrap(),
            summary: "Severance — S02E03".to_string(),
            description: Some("The Grim Barbarity of Optics".to_string()),
        }];
        let ics = build_calendar("Vazute", &events, now());

        assert!(ics.starts_with("BEGIN:VCALENDAR\r\n"));
        assert!(ics.ends_with("END:VCALENDAR\r\n"));
        assert!(ics.contains("\r\nDTSTART;VALUE=DATE:20260801\r\n"));
        // DTEND is the exclusive next day.
        assert!(ics.contains("\r\nDTEND;VALUE=DATE:20260802\r\n"));
        assert!(ics.contains("\r\nUID:ep-1@vazute\r\n"));
        assert!(ics.contains("DTSTAMP:20260726T100000Z"));
        assert!(ics.contains("SUMMARY:Severance"));
        assert!(ics.contains("BEGIN:VEVENT\r\n"));
        assert!(ics.contains("END:VEVENT\r\n"));
    }

    #[test]
    fn omits_empty_description() {
        let events = vec![FeedEvent {
            uid: "u".to_string(),
            date: NaiveDate::from_ymd_opt(2026, 8, 1).unwrap(),
            summary: "Title".to_string(),
            description: Some(String::new()),
        }];
        let ics = build_calendar("Vazute", &events, now());
        assert!(!ics.contains("DESCRIPTION:"));
    }
}
