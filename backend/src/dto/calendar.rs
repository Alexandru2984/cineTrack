use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::errors::AppError;

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
    pub today: Option<NaiveDate>,
    pub limit: Option<u16>,
    pub include_specials: Option<bool>,
}

impl UpNextQuery {
    pub fn resolve(&self) -> Result<ResolvedUpNextQuery, AppError> {
        Ok(ResolvedUpNextQuery {
            today: resolve_today(self.today)?,
            limit: i64::from(self.limit.unwrap_or(6).clamp(1, 20)),
            include_specials: self.include_specials.unwrap_or(false),
        })
    }
}

pub struct ResolvedUpNextQuery {
    pub today: NaiveDate,
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
    pub overview: Option<String>,
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

#[derive(Debug, Serialize)]
pub struct UpNextResponse {
    pub items: Vec<CalendarEpisode>,
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
