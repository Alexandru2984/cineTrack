use std::fmt;
use std::marker::PhantomData;

use serde::de::{self, DeserializeOwned, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};

pub const MAX_SEASONS_PER_SHOW: usize = 200;
pub const MAX_EPISODES_PER_SEASON: usize = 2_000;

fn deserialize_limited_vec<'de, D, T>(deserializer: D, max: usize) -> Result<Vec<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    struct LimitedVecVisitor<T> {
        max: usize,
        marker: PhantomData<T>,
    }

    impl<'de, T> Visitor<'de> for LimitedVecVisitor<T>
    where
        T: Deserialize<'de>,
    {
        type Value = Vec<T>;

        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            write!(formatter, "an array with at most {} items", self.max)
        }

        fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
        where
            A: SeqAccess<'de>,
        {
            let mut values = Vec::with_capacity(sequence.size_hint().unwrap_or(0).min(self.max));
            while let Some(value) = sequence.next_element()? {
                if values.len() == self.max {
                    return Err(de::Error::custom(format_args!(
                        "array exceeds {} items",
                        self.max
                    )));
                }
                values.push(value);
            }
            Ok(values)
        }
    }

    deserializer.deserialize_seq(LimitedVecVisitor {
        max,
        marker: PhantomData,
    })
}

pub fn parse_limited_json_array<T>(bytes: &[u8], max: usize) -> Result<Vec<T>, serde_json::Error>
where
    T: DeserializeOwned,
{
    let mut deserializer = serde_json::Deserializer::from_slice(bytes);
    let values = deserialize_limited_vec(&mut deserializer, max)?;
    deserializer.end()?;
    Ok(values)
}

fn deserialize_seasons<'de, D>(deserializer: D) -> Result<Vec<TvTimeSeason>, D::Error>
where
    D: Deserializer<'de>,
{
    deserialize_limited_vec(deserializer, MAX_SEASONS_PER_SHOW)
}

fn deserialize_episodes<'de, D>(deserializer: D) -> Result<Vec<TvTimeEpisode>, D::Error>
where
    D: Deserializer<'de>,
{
    deserialize_limited_vec(deserializer, MAX_EPISODES_PER_SEASON)
}

/// TV Time external ids attached to a show/movie/episode in the browser-extension export.
#[derive(Debug, Deserialize)]
pub struct TvTimeExternalId {
    pub tvdb: Option<i64>,
    pub imdb: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct TvTimeEpisode {
    pub number: i32,
    #[serde(default)]
    pub is_watched: bool,
    #[serde(default)]
    pub watched_at: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct TvTimeSeason {
    pub number: i32,
    #[serde(default, deserialize_with = "deserialize_episodes")]
    pub episodes: Vec<TvTimeEpisode>,
}

#[derive(Debug, Deserialize)]
pub struct TvTimeShow {
    pub id: TvTimeExternalId,
    #[serde(default)]
    pub title: String,
    #[serde(default, deserialize_with = "deserialize_seasons")]
    pub seasons: Vec<TvTimeSeason>,
    #[serde(default)]
    pub created_at: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct TvTimeMovie {
    pub id: TvTimeExternalId,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub is_watched: bool,
    #[serde(default)]
    pub watched_at: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
}

/// One parsed row of the optional TV Time `rewatched_episode.csv` (GDPR export).
#[derive(Debug)]
pub struct RewatchRow {
    pub show_name: String,
    pub season_number: i32,
    pub episode_number: i32,
    pub created_at: String,
}

/// Summary counts written to `import_jobs.totals` and shown in the UI.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct ImportTotals {
    pub shows: i64,
    pub movies: i64,
    pub episodes_linked: i64,
    pub episodes_date_only: i64,
    pub rewatches: i64,
    pub unresolved: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct ImportJobResponse {
    pub id: uuid::Uuid,
    pub status: String,
    pub totals: Option<serde_json::Value>,
    pub error: Option<String>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}
