use serde::{Deserialize, Serialize};
use validator::Validate;

fn validate_media_type(media_type: &str) -> Result<(), validator::ValidationError> {
    if matches!(media_type, "movie" | "tv") {
        Ok(())
    } else {
        let mut error = validator::ValidationError::new("invalid_media_type");
        error.message = Some("Media type must be movie or tv".into());
        Err(error)
    }
}

#[derive(Debug, Deserialize, Validate)]
pub struct SearchQuery {
    #[validate(length(min = 1, max = 200, message = "Search query must be 1-200 characters"))]
    pub q: String,
    #[serde(rename = "type")]
    #[validate(custom(function = "validate_media_type"))]
    pub media_type: Option<String>,
    #[validate(range(min = 1, max = 500, message = "Page must be between 1 and 500"))]
    pub page: Option<u32>,
}

#[derive(Debug, Serialize)]
pub struct MediaResponse {
    pub id: String,
    pub tmdb_id: i32,
    pub media_type: String,
    pub title: String,
    pub original_title: Option<String>,
    pub overview: Option<String>,
    pub poster_path: Option<String>,
    pub backdrop_path: Option<String>,
    pub release_date: Option<chrono::NaiveDate>,
    pub status: Option<String>,
    pub genres: Option<serde_json::Value>,
    pub runtime_minutes: Option<i32>,
    pub vote_average: Option<f64>,
}

#[derive(Debug, Serialize)]
pub struct SeasonResponse {
    pub id: String,
    pub season_number: i32,
    pub name: Option<String>,
    pub episode_count: Option<i32>,
    pub air_date: Option<chrono::NaiveDate>,
}

#[derive(Debug, Serialize)]
pub struct EpisodeResponse {
    pub id: String,
    pub episode_number: i32,
    pub name: Option<String>,
    pub overview: Option<String>,
    pub runtime_minutes: Option<i32>,
    pub air_date: Option<chrono::NaiveDate>,
    pub still_path: Option<String>,
}

// TMDB API response types
#[derive(Debug, Deserialize, Serialize)]
pub struct TmdbSearchResponse {
    pub page: u32,
    pub total_pages: u32,
    pub total_results: u32,
    pub results: Vec<TmdbSearchResult>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct TmdbSearchResult {
    pub id: i32,
    pub title: Option<String>,
    pub name: Option<String>,
    pub original_title: Option<String>,
    pub original_name: Option<String>,
    pub overview: Option<String>,
    pub poster_path: Option<String>,
    pub backdrop_path: Option<String>,
    pub release_date: Option<String>,
    pub first_air_date: Option<String>,
    pub vote_average: Option<f64>,
    pub media_type: Option<String>,
    pub genre_ids: Option<Vec<i32>>,
}

#[derive(Debug, Deserialize)]
pub struct TmdbMovieDetail {
    pub id: i32,
    pub title: String,
    pub original_title: Option<String>,
    pub overview: Option<String>,
    pub poster_path: Option<String>,
    pub backdrop_path: Option<String>,
    pub release_date: Option<String>,
    pub status: Option<String>,
    pub genres: Option<Vec<TmdbGenre>>,
    pub runtime: Option<i32>,
    pub vote_average: Option<f64>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct TmdbGenre {
    pub id: i32,
    pub name: String,
}

#[derive(Debug, Deserialize)]
pub struct TmdbTvDetail {
    pub id: i32,
    pub name: String,
    pub original_name: Option<String>,
    pub overview: Option<String>,
    pub poster_path: Option<String>,
    pub backdrop_path: Option<String>,
    pub first_air_date: Option<String>,
    pub status: Option<String>,
    pub genres: Option<Vec<TmdbGenre>>,
    pub episode_run_time: Option<Vec<i32>>,
    pub vote_average: Option<f64>,
    pub seasons: Option<Vec<TmdbSeason>>,
}

#[derive(Debug, Deserialize)]
pub struct TmdbSeason {
    pub id: i32,
    pub season_number: i32,
    pub name: Option<String>,
    pub episode_count: Option<i32>,
    pub air_date: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct TmdbSeasonDetail {
    pub episodes: Vec<TmdbEpisode>,
}

#[derive(Debug, Deserialize)]
pub struct TmdbEpisode {
    pub episode_number: i32,
    pub name: Option<String>,
    pub overview: Option<String>,
    pub runtime: Option<i32>,
    pub air_date: Option<String>,
    pub still_path: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct TmdbTrendingResponse {
    pub results: Vec<TmdbSearchResult>,
}

/// `/find/{external_id}` groups matches by media type. Used to map TV Time's
/// TVDB (shows) and IMDB (movies) ids onto TMDB ids during import.
#[derive(Debug, Deserialize, Serialize, Default)]
pub struct TmdbFindResponse {
    #[serde(default)]
    pub movie_results: Vec<TmdbSearchResult>,
    #[serde(default)]
    pub tv_results: Vec<TmdbSearchResult>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn query(q: &str) -> SearchQuery {
        SearchQuery {
            q: q.to_string(),
            media_type: None,
            page: None,
        }
    }

    #[test]
    fn test_search_query_valid() {
        assert!(query("inception").validate().is_ok());
    }

    #[test]
    fn test_search_query_empty_rejected() {
        assert!(query("").validate().is_err());
    }

    #[test]
    fn test_search_query_too_long_rejected() {
        assert!(query(&"x".repeat(201)).validate().is_err());
    }

    #[test]
    fn test_search_query_boundary_200() {
        assert!(query(&"x".repeat(200)).validate().is_ok());
    }

    #[test]
    fn test_search_query_rejects_unknown_media_type() {
        let mut value = query("inception");
        value.media_type = Some("person".to_string());
        assert!(value.validate().is_err());
    }

    #[test]
    fn test_search_query_rejects_out_of_range_page() {
        let mut value = query("inception");
        value.page = Some(501);
        assert!(value.validate().is_err());
    }
}
