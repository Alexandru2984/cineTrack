use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::errors::AppError;

/// Whether the viewer's iCal feed URL is currently active.
#[derive(Debug, Serialize)]
pub struct CalendarFeedStatus {
    pub enabled: bool,
}

/// The plaintext feed URL, returned only at the moment the feed is enabled or
/// regenerated — the server stores only its hash and can never show it again.
#[derive(Debug, Serialize)]
pub struct CalendarFeedCredential {
    pub feed_url: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NewCalendarQuery {
    pub today: Option<NaiveDate>,
    pub days: Option<u16>,
    pub limit: Option<u16>,
    pub before_date: Option<NaiveDate>,
    pub before_id: Option<Uuid>,
    pub include_specials: Option<bool>,
}

impl NewCalendarQuery {
    pub fn resolve(&self) -> Result<ResolvedNewCalendarQuery, AppError> {
        Ok(ResolvedNewCalendarQuery {
            today: resolve_today(self.today)?,
            days: i32::from(self.days.unwrap_or(30).clamp(1, 90)),
            limit: i64::from(self.limit.unwrap_or(50).clamp(1, 100)),
            cursor: match (self.before_date, self.before_id) {
                (Some(date), Some(id)) => Some((date, id)),
                (None, None) => None,
                _ => {
                    return Err(AppError::BadRequest(
                        "Both before_date and before_id are required".to_string(),
                    ));
                }
            },
            include_specials: self.include_specials.unwrap_or(false),
        })
    }
}

pub struct ResolvedNewCalendarQuery {
    pub today: NaiveDate,
    pub days: i32,
    pub limit: i64,
    pub cursor: Option<(NaiveDate, Uuid)>,
    pub include_specials: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpNextQuery {
    /// Accepted and ignored.
    ///
    /// Up Next used to bound "has this aired" with the date the client
    /// reported, which let the caller decide what counted as aired and pulled
    /// episodes forward by a day for anyone east of the origin network. The
    /// server answers that question now.
    ///
    /// Still parsed because `deny_unknown_fields` is on and released clients
    /// send it; removing the field would turn their requests into 400s.
    /// Remove once they no longer do.
    pub today: Option<NaiveDate>,
    pub limit: Option<u16>,
    pub include_specials: Option<bool>,
}

impl UpNextQuery {
    pub fn resolve(&self) -> Result<ResolvedUpNextQuery, AppError> {
        Ok(ResolvedUpNextQuery {
            limit: i64::from(self.limit.unwrap_or(6).clamp(1, 20)),
            include_specials: self.include_specials.unwrap_or(false),
        })
    }
}

pub struct ResolvedUpNextQuery {
    pub limit: i64,
    pub include_specials: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpcomingCalendarQuery {
    pub today: Option<NaiveDate>,
    pub days: Option<u16>,
    pub limit: Option<u16>,
    pub after_date: Option<NaiveDate>,
    pub after_kind: Option<String>,
    pub after_key: Option<String>,
    #[serde(rename = "type")]
    pub item_type: Option<String>,
    pub include_specials: Option<bool>,
}

impl UpcomingCalendarQuery {
    pub fn resolve(&self) -> Result<ResolvedUpcomingCalendarQuery, AppError> {
        let item_type = self.item_type.as_deref().unwrap_or("all");
        let item_kind = match item_type {
            "all" => "all",
            "tv" | "episode" => "episode",
            "movie" => "movie",
            _ => {
                return Err(AppError::BadRequest(
                    "type must be all, tv or movie".to_string(),
                ));
            }
        };
        let cursor = match (&self.after_date, &self.after_kind, &self.after_key) {
            (Some(date), Some(kind), Some(key)) => {
                if !matches!(kind.as_str(), "episode" | "movie")
                    || key.is_empty()
                    || key.len() > 64
                    || !key
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b':')
                {
                    return Err(AppError::BadRequest("Invalid upcoming cursor".to_string()));
                }
                Some((*date, kind.clone(), key.clone()))
            }
            (None, None, None) => None,
            _ => {
                return Err(AppError::BadRequest(
                    "after_date, after_kind and after_key are required together".to_string(),
                ));
            }
        };

        Ok(ResolvedUpcomingCalendarQuery {
            today: resolve_today(self.today)?,
            days: i32::from(self.days.unwrap_or(90).clamp(1, 365)),
            limit: i64::from(self.limit.unwrap_or(50).clamp(1, 100)),
            cursor,
            item_kind: item_kind.to_string(),
            include_specials: self.include_specials.unwrap_or(false),
        })
    }
}

pub struct ResolvedUpcomingCalendarQuery {
    pub today: NaiveDate,
    pub days: i32,
    pub limit: i64,
    pub cursor: Option<(NaiveDate, String, String)>,
    pub item_kind: String,
    pub include_specials: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateCalendarPreferencesRequest {
    pub country_code: String,
}

impl UpdateCalendarPreferencesRequest {
    pub fn normalized_country_code(&self) -> Result<String, AppError> {
        let country_code = self.country_code.trim().to_ascii_uppercase();
        if country_code.len() != 2 || !country_code.bytes().all(|byte| byte.is_ascii_uppercase()) {
            return Err(AppError::BadRequest(
                "country_code must be a two-letter ISO code".to_string(),
            ));
        }
        Ok(country_code)
    }
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct CalendarEpisode {
    pub episode_id: Uuid,
    pub media_id: Uuid,
    pub tmdb_id: i32,
    pub title: String,
    pub poster_path: Option<String>,
    pub season_number: i32,
    pub episode_number: i32,
    pub episode_name: Option<String>,
    /// Deliberately absent: `overview`.
    ///
    /// Episode synopses average 216 characters and no screen here renders one —
    /// the detail pages fetch their own data. A fifty-item calendar page was
    /// carrying ten kilobytes of text nobody reads, and on the native client
    /// that text was also encrypted and written to disk with the query cache.
    pub runtime_minutes: Option<i32>,
    pub air_date: NaiveDate,
    pub still_path: Option<String>,
    pub is_planned: bool,
}

#[derive(Debug, Serialize)]
pub struct EpisodeCursor {
    pub before_date: NaiveDate,
    pub before_id: Uuid,
}

#[derive(Debug, Serialize)]
pub struct CalendarEpisodePage {
    pub items: Vec<CalendarEpisode>,
    pub next_cursor: Option<EpisodeCursor>,
}

/// A calendar episode plus the progress that put it in the queue. Separate from
/// `CalendarEpisode` because `last_watched_at` is only meaningful here: the
/// other calendar endpoints list episodes regardless of whether the show was
/// ever started, so there would be nothing honest to put in the field.
#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct UpNextEpisode {
    pub episode_id: Uuid,
    pub media_id: Uuid,
    pub tmdb_id: i32,
    pub title: String,
    pub poster_path: Option<String>,
    pub season_number: i32,
    pub episode_number: i32,
    pub episode_name: Option<String>,
    /// Deliberately absent: `overview`.
    ///
    /// Episode synopses average 216 characters and no screen here renders one —
    /// the detail pages fetch their own data. A fifty-item calendar page was
    /// carrying ten kilobytes of text nobody reads, and on the native client
    /// that text was also encrypted and written to disk with the query cache.
    pub runtime_minutes: Option<i32>,
    pub air_date: NaiveDate,
    pub still_path: Option<String>,
    pub is_planned: bool,
    /// When the user last watched anything from this show. Never null — the
    /// query only returns shows with at least one watched episode.
    pub last_watched_at: DateTime<Utc>,
}

/// A started show whose next episode cannot be named yet, because a season at
/// or before it has not been fetched from the provider.
///
/// This exists so the queue can stay silent instead of guessing. The episode
/// tables are a lazily filled cache, and picking the lowest *cached* unwatched
/// episode quietly answers a different question than "what comes next" whenever
/// a middle season is missing — it once sent a viewer from season one straight
/// into season three and spoiled the show for them.
#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct UpNextAwaitingCatalog {
    pub media_id: Uuid,
    pub tmdb_id: i32,
    pub title: String,
    pub poster_path: Option<String>,
    /// The earliest season whose episodes are missing or incomplete. Shown to
    /// the viewer so the wait is explained rather than mysterious.
    pub missing_season_number: i32,
    pub last_watched_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct UpNextResponse {
    pub items: Vec<UpNextEpisode>,
    /// Shows deliberately withheld from `items` until their catalogue is
    /// complete enough to answer honestly. A new field rather than a variant in
    /// `items`, so clients already deployed keep parsing the response.
    pub awaiting_catalog: Vec<UpNextAwaitingCatalog>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct UpcomingCalendarItem {
    pub item_kind: String,
    pub item_id: Uuid,
    pub media_id: Uuid,
    pub tmdb_id: i32,
    pub title: String,
    pub poster_path: Option<String>,
    pub release_date: NaiveDate,
    pub release_type: Option<i16>,
    pub season_number: Option<i32>,
    pub episode_number: Option<i32>,
    pub episode_name: Option<String>,
    pub still_path: Option<String>,
    pub is_planned: bool,
    #[serde(skip)]
    pub sort_key: String,
}

#[derive(Debug, Serialize)]
pub struct UpcomingCursor {
    pub after_date: NaiveDate,
    pub after_kind: String,
    pub after_key: String,
}

#[derive(Debug, Serialize)]
pub struct UpcomingCalendarPage {
    pub items: Vec<UpcomingCalendarItem>,
    pub next_cursor: Option<UpcomingCursor>,
    pub country_code: String,
}

#[derive(Debug, Serialize)]
pub struct CalendarSummary {
    pub new_count: i64,
    pub planned_count: i64,
    pub last_synced_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize)]
pub struct CalendarPreferences {
    pub country_code: String,
}

fn resolve_today(requested: Option<NaiveDate>) -> Result<NaiveDate, AppError> {
    let server_today = Utc::now().date_naive();
    let today = requested.unwrap_or(server_today);
    if (today - server_today).num_days().abs() > 1 {
        return Err(AppError::BadRequest(
            "today must match the current local date".to_string(),
        ));
    }
    Ok(today)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calendar_ranges_are_bounded() {
        let resolved = NewCalendarQuery {
            today: None,
            days: Some(u16::MAX),
            limit: Some(u16::MAX),
            before_date: None,
            before_id: None,
            include_specials: None,
        }
        .resolve()
        .unwrap();
        assert_eq!(resolved.days, 90);
        assert_eq!(resolved.limit, 100);

        let up_next = UpNextQuery {
            today: None,
            limit: Some(u16::MAX),
            include_specials: None,
        }
        .resolve()
        .unwrap();
        assert_eq!(up_next.limit, 20);
    }

    #[test]
    fn incomplete_or_malformed_cursors_are_rejected() {
        let query = UpcomingCalendarQuery {
            today: None,
            days: None,
            limit: None,
            after_date: Some(Utc::now().date_naive()),
            after_kind: Some("episode".to_string()),
            after_key: None,
            item_type: None,
            include_specials: None,
        };
        assert!(matches!(query.resolve(), Err(AppError::BadRequest(_))));
    }

    #[test]
    fn country_codes_are_canonicalized() {
        assert_eq!(
            UpdateCalendarPreferencesRequest {
                country_code: " ro ".to_string(),
            }
            .normalized_country_code()
            .unwrap(),
            "RO"
        );
        assert!(UpdateCalendarPreferencesRequest {
            country_code: "../../../".to_string(),
        }
        .normalized_country_code()
        .is_err());
    }
}
