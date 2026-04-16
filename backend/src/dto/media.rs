use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
pub struct SearchQuery {
    pub q: String,
    #[serde(rename = "type")]
    pub media_type: Option<String>,
    pub page: Option<u32>,
}

#[derive(Debug, Serialize)]
pub struct MediaResponse {
    pub id: uuid::Uuid,
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
    pub id: uuid::Uuid,
    pub season_number: i32,
    pub name: Option<String>,
    pub episode_count: Option<i32>,
    pub air_date: Option<chrono::NaiveDate>,
}

#[derive(Debug, Serialize)]
pub struct EpisodeResponse {
    pub id: uuid::Uuid,
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
