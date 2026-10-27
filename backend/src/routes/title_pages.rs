//! Public pages for films and series, for search engines and for people who
//! arrive from them.
//!
//! Everything else in Văzute sits behind a sign-in, and the application is one
//! JavaScript bundle: a search engine fetching `/media/550` got an empty shell
//! whose canonical link named the home page. In October 2026 that left the
//! whole site with nine indexable pages, none of them about a film.
//!
//! These pages are rendered here, as plain HTML, from what the catalogue
//! already holds: the synopsis, the seasons and the next episode, when a film
//! opens in Romania, and where it can be watched there. They are published in
//! Romanian and in English, each naming the other with `hreflang`.
//!
//! # Which titles get a page
//!
//! Only a title with detail metadata and a place in the catalogue inventory:
//! `popularity` is NULL exactly when the inventory has no non-adult, non-video
//! row for it (see the migration that added it). Anything else is a 404, so
//! these routes never ask TMDB for a title nobody has looked up, whatever URL a
//! crawler invents. The one upstream call a page can make is for streaming
//! availability, which is cached for a day and has a short deadline here.

use std::time::Duration;

use actix_web::{http::header, web, HttpRequest, HttpResponse, HttpResponseBuilder};
use chrono::{Datelike, NaiveDate};
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

use crate::dto::media::{TmdbGenre, WatchProviderEntry, WatchProvidersResponse};
use crate::errors::AppError;
use crate::services::tmdb::TmdbService;

pub(crate) const SITE: &str = "https://vazute.micutu.com";
pub(crate) const IMAGE_BASE: &str = "https://image.tmdb.org/t/p";
/// How long a page waits for streaming availability before rendering without
/// it. Cached answers return at once; this only bounds a cold fetch.
const PROVIDERS_DEADLINE: Duration = Duration::from_secs(3);
const DESCRIPTION_CHARS: usize = 155;

/// Starts a server-rendered HTML response, kept by caches as `cache` says.
///
/// Every one of these pages adds `no-transform`. Without it Cloudflare's
/// JavaScript Detections and Web Analytics rewrite the document on its way out,
/// adding an inline bootstrap and a beacon script that the strict CSP then
/// blocks: the page gains nothing, and each visit files two CSP violation
/// reports. `frontend/nginx-spa.conf` says the same for the application's own
/// HTML; these pages came later and went without it until October 2026.
pub(crate) fn html_page(mut response: HttpResponseBuilder, cache: &str) -> HttpResponseBuilder {
    response
        .content_type("text/html; charset=utf-8")
        .insert_header((header::CACHE_CONTROL, format!("{cache}, no-transform")));
    response
}

pub fn configure_rate_limited(
    cfg: &mut web::ServiceConfig,
    limiter: &crate::routes::SharedGovernorConfig,
) {
    cfg.service(romanian().wrap(crate::middleware::rate_limit::RateLimit::new(limiter)));
    cfg.service(english().wrap(crate::middleware::rate_limit::RateLimit::new(limiter)));
}

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(romanian());
    cfg.service(english());
}

// Two prefixed scopes rather than one at the root: an empty-prefix scope
// matches every path, and would answer `/api/...` with its own 404 before the
// API scope registered after it was ever consulted. HEAD as well as GET, for
// the reason given in `unfurl::configure`.
// The genre and popularity lists share the scopes, for the same reason.
fn romanian() -> actix_web::Scope {
    crate::routes::hubs::romanian_routes(web::scope("/ro"))
        .route("/film/{slug}", web::get().to(ro_movie))
        .route("/film/{slug}", web::head().to(ro_movie))
        .route("/serial/{slug}", web::get().to(ro_tv))
        .route("/serial/{slug}", web::head().to(ro_tv))
}

fn english() -> actix_web::Scope {
    crate::routes::hubs::english_routes(web::scope("/en"))
        .route("/movie/{slug}", web::get().to(en_movie))
        .route("/movie/{slug}", web::head().to(en_movie))
        .route("/tv/{slug}", web::get().to(en_tv))
        .route("/tv/{slug}", web::head().to(en_tv))
}

type Pool = web::Data<PgPool>;
type Tmdb = web::Data<TmdbService>;
type Slug = web::Path<String>;

async fn ro_movie(
    pool: Pool,
    tmdb: Tmdb,
    req: HttpRequest,
    slug: Slug,
) -> Result<HttpResponse, AppError> {
    title_page(pool, tmdb, req, slug, Language::Ro, Kind::Movie).await
}

async fn ro_tv(
    pool: Pool,
    tmdb: Tmdb,
    req: HttpRequest,
    slug: Slug,
) -> Result<HttpResponse, AppError> {
    title_page(pool, tmdb, req, slug, Language::Ro, Kind::Tv).await
}

async fn en_movie(
    pool: Pool,
    tmdb: Tmdb,
    req: HttpRequest,
    slug: Slug,
) -> Result<HttpResponse, AppError> {
    title_page(pool, tmdb, req, slug, Language::En, Kind::Movie).await
}

async fn en_tv(
    pool: Pool,
    tmdb: Tmdb,
    req: HttpRequest,
    slug: Slug,
) -> Result<HttpResponse, AppError> {
    title_page(pool, tmdb, req, slug, Language::En, Kind::Tv).await
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Language {
    Ro,
    En,
}

impl Language {
    pub(crate) fn code(self) -> &'static str {
        match self {
            Language::Ro => "ro",
            Language::En => "en",
        }
    }

    fn other(self) -> Self {
        match self {
            Language::Ro => Language::En,
            Language::En => Language::Ro,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Movie,
    Tv,
}

impl Kind {
    fn media_type(self) -> &'static str {
        match self {
            Kind::Movie => "movie",
            Kind::Tv => "tv",
        }
    }

    fn segment(self, language: Language) -> &'static str {
        match (language, self) {
            (Language::Ro, Kind::Movie) => "film",
            (Language::Ro, Kind::Tv) => "serial",
            (Language::En, Kind::Movie) => "movie",
            (Language::En, Kind::Tv) => "tv",
        }
    }
}

/// A URL-safe rendering of a title: lowercase ASCII words joined by hyphens.
///
/// Romanian diacritics and the common Latin accents are folded to their base
/// letter, so `Băieți răi` reads as `baieti-rai` rather than losing letters.
/// A title in a script with no such folding yields nothing, and its address is
/// the bare id — still unique, just less descriptive.
pub fn slugify(title: &str) -> String {
    let mut slug = String::new();
    let mut pending_hyphen = false;
    for character in title.chars().flat_map(char::to_lowercase) {
        let folded = match character {
            'ă' | 'â' | 'á' | 'à' | 'ä' | 'ã' | 'å' => Some('a'),
            'î' | 'í' | 'ì' | 'ï' => Some('i'),
            'ș' | 'ş' | 'š' | 'ś' => Some('s'),
            'ț' | 'ţ' => Some('t'),
            'é' | 'è' | 'ê' | 'ë' => Some('e'),
            'ó' | 'ò' | 'ô' | 'ö' | 'õ' | 'ø' => Some('o'),
            'ú' | 'ù' | 'û' | 'ü' => Some('u'),
            'ç' | 'ć' | 'č' => Some('c'),
            'ñ' | 'ń' => Some('n'),
            'ž' | 'ź' | 'ż' => Some('z'),
            'ý' | 'ÿ' => Some('y'),
            'ł' => Some('l'),
            'đ' => Some('d'),
            'ß' => Some('s'),
            c if c.is_ascii_alphanumeric() => Some(c),
            _ => None,
        };
        match folded {
            Some(letter) => {
                if pending_hyphen && !slug.is_empty() {
                    slug.push('-');
                }
                pending_hyphen = false;
                slug.push(letter);
            }
            None => pending_hyphen = true,
        }
        if slug.len() >= 80 {
            break;
        }
    }
    slug.trim_end_matches('-').to_string()
}

/// The canonical path of a title's page in one language.
pub fn page_path(language: Language, kind: Kind, tmdb_id: i32, title: &str) -> String {
    let slug = slugify(title);
    let segment = kind.segment(language);
    let code = language.code();
    if slug.is_empty() {
        format!("/{code}/{segment}/{tmdb_id}")
    } else {
        format!("/{code}/{segment}/{tmdb_id}-{slug}")
    }
}

/// The TMDB id at the front of a page's last segment, `550-fight-club`.
fn parse_id(slug: &str) -> Option<i32> {
    let digits = slug.split('-').next()?;
    if digits.is_empty() || digits.len() > 9 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse::<i32>().ok().filter(|id| *id > 0)
}

#[derive(sqlx::FromRow)]
struct TitleRow {
    id: Uuid,
    tmdb_id: i32,
    title: String,
    original_title: Option<String>,
    overview: Option<String>,
    poster_path: Option<String>,
    release_date: Option<NaiveDate>,
    status: Option<String>,
    genres: Option<serde_json::Value>,
    runtime_minutes: Option<i32>,
    ro_title: Option<String>,
    ro_overview: Option<String>,
}

impl TitleRow {
    fn title_in(&self, language: Language) -> &str {
        match language {
            Language::Ro => self.ro_title.as_deref().unwrap_or(&self.title),
            Language::En => &self.title,
        }
    }

    /// The synopsis for a language, and the language it is actually in.
    fn overview_in(&self, language: Language) -> Option<(&str, Language)> {
        let english = self
            .overview
            .as_deref()
            .filter(|text| !text.trim().is_empty())
            .map(|text| (text, Language::En));
        match language {
            Language::Ro => self
                .ro_overview
                .as_deref()
                .map(|text| (text, Language::Ro))
                .or(english),
            Language::En => english,
        }
    }
}

struct SeasonRow {
    season_number: i32,
    episode_count: Option<i32>,
    air_date: Option<NaiveDate>,
}

struct NextEpisode {
    season_number: i32,
    episode_number: i32,
    name: Option<String>,
    air_date: NaiveDate,
}

struct Page {
    language: Language,
    kind: Kind,
    row: TitleRow,
    seasons: Vec<SeasonRow>,
    next_episode: Option<NextEpisode>,
    romanian_releases: Vec<(i32, NaiveDate)>,
    providers: Option<WatchProvidersResponse>,
    related: Vec<Related>,
}

/// Another title of the same kind and genre, linked from the page.
struct Related {
    tmdb_id: i32,
    title: String,
    ro_title: Option<String>,
    release_date: Option<NaiveDate>,
}

impl Related {
    fn title_in(&self, language: Language) -> &str {
        match language {
            Language::Ro => self.ro_title.as_deref().unwrap_or(&self.title),
            Language::En => &self.title,
        }
    }
}

/// How many related titles a page links to.
const RELATED_LIMIT: i64 = 12;

async fn title_page(
    pool: web::Data<PgPool>,
    tmdb: web::Data<TmdbService>,
    req: HttpRequest,
    slug: web::Path<String>,
    language: Language,
    kind: Kind,
) -> Result<HttpResponse, AppError> {
    let Some(tmdb_id) = parse_id(&slug) else {
        return Ok(not_found(language));
    };

    let row = sqlx::query_as::<_, TitleRow>(
        r#"SELECT m.id, m.tmdb_id, m.title, m.original_title, m.overview, m.poster_path,
                  m.release_date, m.status, m.genres, m.runtime_minutes,
                  l.title AS ro_title, l.overview AS ro_overview
        FROM media m
        LEFT JOIN media_localizations l
          ON l.media_id = m.id AND l.language_code = 'ro'
        WHERE m.tmdb_id = $1
          AND m.media_type = $2
          AND m.metadata_level = 'detail'
          AND m.popularity IS NOT NULL"#,
    )
    .bind(tmdb_id)
    .bind(kind.media_type())
    .fetch_optional(pool.get_ref())
    .await?;
    let Some(row) = row else {
        return Ok(not_found(language));
    };

    // One address per page: an old slug, a renamed title or a bare id all
    // land on the current one, so links anywhere keep working and the index
    // holds one URL.
    let canonical = page_path(language, kind, row.tmdb_id, row.title_in(language));
    if req.path() != canonical {
        return Ok(HttpResponse::MovedPermanently()
            .insert_header(("Location", canonical))
            .insert_header(("Cache-Control", "public, max-age=86400"))
            .finish());
    }

    let (seasons, next_episode, romanian_releases) = match kind {
        Kind::Tv => (
            seasons(pool.get_ref(), row.id).await?,
            next_episode(pool.get_ref(), row.id).await?,
            Vec::new(),
        ),
        Kind::Movie => (
            Vec::new(),
            None,
            romanian_releases(pool.get_ref(), row.id).await?,
        ),
    };

    let providers = match tokio::time::timeout(
        PROVIDERS_DEADLINE,
        tmdb.get_watch_providers(pool.get_ref(), kind.media_type(), row.tmdb_id),
    )
    .await
    {
        Ok(Ok(response)) => Some(
            response
                .results
                .get("RO")
                .cloned()
                .unwrap_or_default()
                .into_response("RO".to_string()),
        ),
        // Rendered without the section rather than failing the page: the rest
        // of it is still worth serving, and the next fetch will likely work.
        Ok(Err(error)) => {
            log::warn!("Title page rendered without watch providers: {error}");
            None
        }
        Err(_) => {
            log::warn!("Title page rendered without watch providers: deadline passed");
            None
        }
    };

    let related = match genres(&row).first() {
        Some(genre) => related(pool.get_ref(), kind, row.id, genre.id).await?,
        None => Vec::new(),
    };

    let page = Page {
        language,
        kind,
        row,
        seasons,
        next_episode,
        romanian_releases,
        providers,
        related,
    };
    // The same document for everyone: nothing on it depends on who asks.
    Ok(html_page(HttpResponse::Ok(), "public, max-age=3600").body(render(&page)))
}

/// The most popular other titles that share the page's first genre and have a
/// page of their own.
///
/// These links are how a crawler that arrives on one title finds the rest: the
/// application links nowhere it can follow, and the sitemap only says which
/// pages exist, not how they relate.
async fn related(
    pool: &PgPool,
    kind: Kind,
    media_id: Uuid,
    genre_id: i32,
) -> Result<Vec<Related>, sqlx::Error> {
    let rows = sqlx::query_as::<_, (i32, String, Option<String>, Option<NaiveDate>)>(
        r#"SELECT m.tmdb_id, m.title, l.title, m.release_date
        FROM media m
        LEFT JOIN media_localizations l
          ON l.media_id = m.id AND l.language_code = 'ro'
        WHERE m.media_type = $1
          AND m.metadata_level = 'detail'
          AND m.popularity IS NOT NULL
          AND m.id <> $2
          AND m.genres @> jsonb_build_array(jsonb_build_object('id', $3::int))
        ORDER BY m.popularity DESC, m.tmdb_id
        LIMIT $4"#,
    )
    .bind(kind.media_type())
    .bind(media_id)
    .bind(genre_id)
    .bind(RELATED_LIMIT)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(tmdb_id, title, ro_title, release_date)| Related {
            tmdb_id,
            title,
            ro_title,
            release_date,
        })
        .collect())
}

async fn seasons(pool: &PgPool, media_id: Uuid) -> Result<Vec<SeasonRow>, sqlx::Error> {
    let rows = sqlx::query_as::<_, (i32, Option<i32>, Option<NaiveDate>)>(
        r#"SELECT season_number, episode_count, air_date
        FROM seasons
        WHERE media_id = $1 AND season_number > 0
        ORDER BY season_number"#,
    )
    .bind(media_id)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(season_number, episode_count, air_date)| SeasonRow {
            season_number,
            episode_count,
            air_date,
        })
        .collect())
}

async fn next_episode(pool: &PgPool, media_id: Uuid) -> Result<Option<NextEpisode>, sqlx::Error> {
    let row = sqlx::query_as::<_, (i32, i32, Option<String>, NaiveDate)>(
        r#"SELECT s.season_number, e.episode_number, e.name, e.air_date
        FROM episodes e
        JOIN seasons s ON s.id = e.season_id
        WHERE s.media_id = $1
          AND s.season_number > 0
          AND e.air_date >= CURRENT_DATE
        ORDER BY e.air_date, s.season_number, e.episode_number
        LIMIT 1"#,
    )
    .bind(media_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(
        |(season_number, episode_number, name, air_date)| NextEpisode {
            season_number,
            episode_number,
            name,
            air_date,
        },
    ))
}

/// The earliest Romanian date for each kind of release: cinema (3, and 2 for a
/// limited run) and digital (4).
async fn romanian_releases(
    pool: &PgPool,
    media_id: Uuid,
) -> Result<Vec<(i32, NaiveDate)>, sqlx::Error> {
    sqlx::query_as::<_, (i32, NaiveDate)>(
        r#"SELECT CASE WHEN release_type = 2 THEN 3 ELSE release_type END AS kind,
                  MIN(release_date)
        FROM media_release_dates
        WHERE media_id = $1 AND country_code = 'RO' AND release_type IN (2, 3, 4)
        GROUP BY 1
        ORDER BY 1"#,
    )
    .bind(media_id)
    .fetch_all(pool)
    .await
}

/// Escape text for HTML, in content or in a quoted attribute.
pub(crate) fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/// Cut on a word boundary, for a meta description or an unfurl card.
pub(crate) fn shorten(value: &str, limit: usize) -> String {
    let text = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() <= limit {
        return text;
    }
    let truncated: String = text.chars().take(limit).collect();
    match truncated.rsplit_once(' ') {
        Some((head, _)) => format!("{head}…"),
        None => format!("{truncated}…"),
    }
}

const RO_MONTHS: [&str; 12] = [
    "ianuarie",
    "februarie",
    "martie",
    "aprilie",
    "mai",
    "iunie",
    "iulie",
    "august",
    "septembrie",
    "octombrie",
    "noiembrie",
    "decembrie",
];
const EN_MONTHS: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];

fn format_date(date: NaiveDate, language: Language) -> String {
    let month = date.month0() as usize;
    match language {
        Language::Ro => format!("{} {} {}", date.day(), RO_MONTHS[month], date.year()),
        Language::En => format!("{} {}, {}", EN_MONTHS[month], date.day(), date.year()),
    }
}

fn format_runtime(minutes: i32, language: Language) -> String {
    let (hours, rest) = (minutes / 60, minutes % 60);
    match (hours, language) {
        (0, _) => format!("{rest} min"),
        (_, Language::Ro) if rest == 0 => format!("{hours} h"),
        (_, Language::En) if rest == 0 => format!("{hours}h"),
        (_, Language::Ro) => format!("{hours} h {rest} min"),
        (_, Language::En) => format!("{hours}h {rest}m"),
    }
}

/// A genre's name in the page's language, from the table the lists use.
fn genre_name(genre: &TmdbGenre, language: Language) -> String {
    match crate::routes::hubs::genre_by_id(genre.id) {
        Some(known) => known.name(language).to_string(),
        // A genre TMDB adds later keeps its own (English) name rather than
        // vanishing from the page.
        None => genre.name.clone(),
    }
}

fn status_name(status: &str, language: Language) -> Option<&'static str> {
    Some(match (status, language) {
        ("Returning Series", Language::Ro) => "În desfășurare",
        ("Returning Series", Language::En) => "Returning series",
        ("Ended", Language::Ro) => "Încheiat",
        ("Ended", Language::En) => "Ended",
        ("Canceled", Language::Ro) => "Anulat",
        ("Canceled", Language::En) => "Canceled",
        ("In Production", Language::Ro) => "În producție",
        ("In Production", Language::En) => "In production",
        ("Planned", Language::Ro) => "Planificat",
        ("Planned", Language::En) => "Planned",
        _ => return None,
    })
}

/// The words a page uses, in its language.
struct Words {
    kind: &'static str,
    title_suffix: &'static str,
    about: &'static str,
    no_overview: &'static str,
    original_title: &'static str,
    add: &'static str,
    where_heading: &'static str,
    stream: &'static str,
    rent: &'static str,
    buy: &'static str,
    nowhere: &'static str,
    unknown_availability: &'static str,
    justwatch: &'static str,
    justwatch_link: &'static str,
    seasons: &'static str,
    season: &'static str,
    episodes_one: &'static str,
    episodes_many: &'static str,
    next_episode: &'static str,
    releases: &'static str,
    cinema: &'static str,
    digital: &'static str,
    other_language: &'static str,
    tmdb_notice: &'static str,
    about_link: &'static str,
    privacy_link: &'static str,
    tagline: &'static str,
}

fn words(language: Language, kind: Kind) -> Words {
    let ro = language == Language::Ro;
    let movie = kind == Kind::Movie;
    Words {
        kind: match (ro, movie) {
            (true, true) => "Film",
            (true, false) => "Serial",
            (false, true) => "Movie",
            (false, false) => "TV series",
        },
        title_suffix: match (ro, movie) {
            (true, true) => "unde îl vezi online, rezumat și lansare",
            (true, false) => "unde îl vezi online, sezoane și episoade noi",
            (false, true) => "where to watch, synopsis and release dates",
            (false, false) => "where to watch, seasons and new episodes",
        },
        about: match (ro, movie) {
            (true, true) => "Despre film",
            (true, false) => "Despre serial",
            (false, true) => "About the movie",
            (false, false) => "About the series",
        },
        no_overview: if ro {
            "Nu avem încă un rezumat pentru acest titlu."
        } else {
            "There is no synopsis for this title yet."
        },
        original_title: if ro {
            "Titlu original"
        } else {
            "Original title"
        },
        add: if ro {
            "Adaugă în lista ta pe Văzute"
        } else {
            "Add it to your list on Văzute"
        },
        where_heading: if ro {
            "Unde poți vedea online în România"
        } else {
            "Where to watch in Romania"
        },
        stream: if ro {
            "Abonament sau gratuit"
        } else {
            "Stream"
        },
        rent: if ro { "Închiriere" } else { "Rent" },
        buy: if ro { "Cumpărare" } else { "Buy" },
        nowhere: if ro {
            "Momentan nu apare pe nicio platformă de streaming din România."
        } else {
            "It is not currently listed on any streaming service in Romania."
        },
        unknown_availability: if ro {
            "Nu am putut afla acum unde se poate vedea. Încearcă din nou mai târziu."
        } else {
            "Availability could not be checked right now. Try again later."
        },
        justwatch: if ro {
            "Date despre disponibilitate furnizate de JustWatch."
        } else {
            "Availability data by JustWatch."
        },
        justwatch_link: if ro {
            "Vezi toate ofertele"
        } else {
            "See every offer"
        },
        seasons: if ro { "Sezoane" } else { "Seasons" },
        season: if ro { "Sezonul" } else { "Season" },
        episodes_one: if ro { "episod" } else { "episode" },
        episodes_many: if ro { "episoade" } else { "episodes" },
        next_episode: if ro {
            "Următorul episod"
        } else {
            "Next episode"
        },
        releases: if ro {
            "Lansare în România"
        } else {
            "Release in Romania"
        },
        cinema: if ro { "La cinema" } else { "In cinemas" },
        digital: if ro { "Online" } else { "Digital" },
        other_language: if ro { "English" } else { "Română" },
        tmdb_notice: if ro {
            "Date despre filme și seriale de la TMDB. Văzute folosește API-ul TMDB, dar nu este aprobat sau certificat de TMDB."
        } else {
            "Film and series data from TMDB. Văzute uses the TMDB API but is not endorsed or certified by TMDB."
        },
        about_link: if ro {
            "Despre Văzute"
        } else {
            "About Văzute"
        },
        privacy_link: if ro { "Confidențialitate" } else { "Privacy" },
        tagline: if ro {
            "Ține evidența filmelor și serialelor pe care le vezi."
        } else {
            "Keep track of the films and series you watch."
        },
    }
}

fn year(date: Option<NaiveDate>) -> Option<i32> {
    date.map(|date| date.year())
}

fn genres(row: &TitleRow) -> Vec<TmdbGenre> {
    row.genres
        .clone()
        .and_then(|value| serde_json::from_value::<Vec<TmdbGenre>>(value).ok())
        .unwrap_or_default()
}

fn provider_list(heading: &str, providers: &[WatchProviderEntry]) -> String {
    if providers.is_empty() {
        return String::new();
    }
    let items = providers
        .iter()
        .map(|provider| {
            let name = escape(&provider.name);
            match &provider.logo_path {
                Some(logo) => format!(
                    r#"<li><img src="{IMAGE_BASE}/w92{logo}" alt="" width="46" height="46" loading="lazy" decoding="async" /><span>{name}</span></li>"#,
                    logo = escape(logo)
                ),
                None => format!("<li><span>{name}</span></li>"),
            }
        })
        .collect::<String>();
    format!(
        r#"<div class="offers"><h3>{heading}</h3><ul class="providers">{items}</ul></div>"#,
        heading = escape(heading)
    )
}

/// Structured data a search engine reads for the title.
fn structured_data(page: &Page, title: &str, description: Option<&str>, url: &str) -> String {
    let row = &page.row;
    let mut data = json!({
        "@context": "https://schema.org",
        "@type": if page.kind == Kind::Movie { "Movie" } else { "TVSeries" },
        "name": title,
        "url": url,
        "inLanguage": page.language.code(),
        "genre": genres(row).iter().map(|genre| genre_name(genre, page.language)).collect::<Vec<_>>(),
    });
    if let Some(original) = row
        .original_title
        .as_deref()
        .filter(|original| *original != title)
    {
        data["alternateName"] = json!(original);
    }
    if let Some(description) = description {
        data["description"] = json!(description);
    }
    if let Some(poster) = &row.poster_path {
        data["image"] = json!(format!("{IMAGE_BASE}/w500{poster}"));
    }
    if let Some(date) = row.release_date {
        let key = if page.kind == Kind::Movie {
            "datePublished"
        } else {
            "startDate"
        };
        data[key] = json!(date.format("%Y-%m-%d").to_string());
    }
    if page.kind == Kind::Movie {
        if let Some(minutes) = row.runtime_minutes.filter(|minutes| *minutes > 0) {
            data["duration"] = json!(format!("PT{}H{}M", minutes / 60, minutes % 60));
        }
    } else if !page.seasons.is_empty() {
        data["numberOfSeasons"] = json!(page.seasons.len());
    }
    // `<`, `>` and `&` as JSON escapes, so nothing in a title can end the
    // script element (`</script`) or open a comment-like state (`<!--`) inside
    // it. A JSON reader sees the same string.
    serde_json::to_string(&data)
        .unwrap_or_default()
        .replace('<', "\\u003c")
        .replace('>', "\\u003e")
        .replace('&', "\\u0026")
}

fn render(page: &Page) -> String {
    let language = page.language;
    let other = language.other();
    let kind = page.kind;
    let row = &page.row;
    let w = words(language, kind);

    let title = row.title_in(language);
    let path = page_path(language, kind, row.tmdb_id, title);
    let other_path = page_path(other, kind, row.tmdb_id, row.title_in(other));
    let (ro_path, en_path) = match language {
        Language::Ro => (path.clone(), other_path.clone()),
        Language::En => (other_path.clone(), path.clone()),
    };
    let url = format!("{SITE}{path}");
    let year = year(row.release_date);
    let heading_year = year.map(|year| format!(" ({year})")).unwrap_or_default();

    let overview = row.overview_in(language);
    let description = match overview {
        Some((text, _)) => shorten(text, DESCRIPTION_CHARS),
        None => format!("{title}{heading_year} — {}.", w.title_suffix),
    };
    let document_title = format!("{title}{heading_year} — {} | Văzute", w.title_suffix);

    let mut facts = vec![w.kind.to_string()];
    if let Some(year) = year {
        facts.push(year.to_string());
    }
    if kind == Kind::Movie {
        if let Some(minutes) = row.runtime_minutes.filter(|minutes| *minutes > 0) {
            facts.push(format_runtime(minutes, language));
        }
    } else if let Some(status) = row
        .status
        .as_deref()
        .and_then(|status| status_name(status, language))
    {
        facts.push(status.to_string());
    }
    let facts = facts
        .iter()
        .map(|fact| escape(fact))
        .collect::<Vec<_>>()
        .join(" · ");

    let original = row
        .original_title
        .as_deref()
        .filter(|original| *original != title)
        .map(|original| {
            format!(
                r#"<p class="original">{}: <span lang="">{}</span></p>"#,
                w.original_title,
                escape(original)
            )
        })
        .unwrap_or_default();

    // Each genre links to its list, which links back: the path a crawler
    // takes between titles of a kind.
    let genre_items = genres(row)
        .iter()
        .map(|genre| {
            let name = escape(&genre_name(genre, language));
            match crate::routes::hubs::genre_by_id(genre.id).filter(|known| known.applies_to(kind))
            {
                Some(known) => format!(
                    r#"<li><a href="{}">{name}</a></li>"#,
                    crate::routes::hubs::hub_path(language, kind, Some(known))
                ),
                None => format!("<li>{name}</li>"),
            }
        })
        .collect::<String>();
    let genre_list = if genre_items.is_empty() {
        String::new()
    } else {
        format!(r#"<ul class="genres">{genre_items}</ul>"#)
    };

    let poster = row
        .poster_path
        .as_deref()
        .map(|poster| {
            format!(
                r#"<img class="poster" src="{IMAGE_BASE}/w342{poster}" srcset="{IMAGE_BASE}/w342{poster} 1x, {IMAGE_BASE}/w780{poster} 2x" alt="{alt}" width="342" height="513" fetchpriority="high" />"#,
                poster = escape(poster),
                alt = escape(&format!("Poster {title}"))
            )
        })
        .unwrap_or_default();

    let synopsis = match overview {
        Some((text, written_in)) => {
            let lang = if written_in != language {
                format!(r#" lang="{}""#, written_in.code())
            } else {
                String::new()
            };
            text.split('\n')
                .filter(|paragraph| !paragraph.trim().is_empty())
                .map(|paragraph| format!("<p{lang}>{}</p>", escape(paragraph.trim())))
                .collect::<String>()
        }
        None => format!(r#"<p class="muted">{}</p>"#, w.no_overview),
    };

    let availability = match &page.providers {
        Some(offers) => {
            let lists = [
                provider_list(w.stream, &offers.stream),
                provider_list(w.rent, &offers.rent),
                provider_list(w.buy, &offers.buy),
            ]
            .concat();
            let body = if lists.is_empty() {
                format!(r#"<p class="muted">{}</p>"#, w.nowhere)
            } else {
                lists
            };
            let link = offers
                .link
                .as_deref()
                .map(|link| {
                    format!(
                        r#" <a href="{}" rel="nofollow noopener" target="_blank">{}</a>"#,
                        escape(link),
                        w.justwatch_link
                    )
                })
                .unwrap_or_default();
            format!(r#"{body}<p class="attribution">{}{link}</p>"#, w.justwatch)
        }
        None => format!(r#"<p class="muted">{}</p>"#, w.unknown_availability),
    };

    let mut sections = String::new();
    sections.push_str(&format!(
        r#"<section><h2>{}</h2>{synopsis}</section>"#,
        w.about
    ));
    sections.push_str(&format!(
        r#"<section><h2>{} — {}</h2>{availability}</section>"#,
        w.where_heading,
        escape(title)
    ));

    if kind == Kind::Tv {
        let mut body = String::new();
        if let Some(next) = &page.next_episode {
            let name = next
                .name
                .as_deref()
                .filter(|name| !name.trim().is_empty())
                .map(|name| format!(" — {}", escape(name)))
                .unwrap_or_default();
            body.push_str(&format!(
                r#"<p class="next"><strong>{}:</strong> S{:02}E{:02}{name}, {}</p>"#,
                w.next_episode,
                next.season_number,
                next.episode_number,
                format_date(next.air_date, language)
            ));
        }
        if !page.seasons.is_empty() {
            let items = page
                .seasons
                .iter()
                .map(|season| {
                    let mut parts = vec![format!("{} {}", w.season, season.season_number)];
                    if let Some(count) = season.episode_count.filter(|count| *count > 0) {
                        let noun = if count == 1 {
                            w.episodes_one
                        } else {
                            w.episodes_many
                        };
                        parts.push(format!("{count} {noun}"));
                    }
                    if let Some(date) = season.air_date {
                        parts.push(format_date(date, language));
                    }
                    format!("<li>{}</li>", escape(&parts.join(" · ")))
                })
                .collect::<String>();
            body.push_str(&format!(r#"<ul class="seasons">{items}</ul>"#));
        }
        if !body.is_empty() {
            sections.push_str(&format!(
                r#"<section><h2>{}</h2>{body}</section>"#,
                w.seasons
            ));
        }
    } else if !page.romanian_releases.is_empty() {
        let items = page
            .romanian_releases
            .iter()
            .map(|(release_kind, date)| {
                let label = if *release_kind == 4 {
                    w.digital
                } else {
                    w.cinema
                };
                format!(
                    "<li><strong>{label}:</strong> {}</li>",
                    format_date(*date, language)
                )
            })
            .collect::<String>();
        sections.push_str(&format!(
            r#"<section><h2>{}</h2><ul class="releases">{items}</ul></section>"#,
            w.releases
        ));
    }

    if let (Some(genre), false) = (genres(row).first(), page.related.is_empty()) {
        let genre = genre_name(genre, language);
        let heading = match (language, kind) {
            (Language::Ro, Kind::Movie) => format!("Alte filme din genul {genre}"),
            (Language::Ro, Kind::Tv) => format!("Alte seriale din genul {genre}"),
            (Language::En, Kind::Movie) => format!("More {genre} movies"),
            (Language::En, Kind::Tv) => format!("More {genre} series"),
        };
        let items = page
            .related
            .iter()
            .map(|other| {
                let name = other.title_in(language);
                let released = self::year(other.release_date)
                    .map(|year| format!(" ({year})"))
                    .unwrap_or_default();
                format!(
                    r#"<li><a href="{}">{}{released}</a></li>"#,
                    escape(&page_path(language, kind, other.tmdb_id, name)),
                    escape(name)
                )
            })
            .collect::<String>();
        sections.push_str(&format!(
            r#"<section><h2>{}</h2><ul class="related">{items}</ul></section>"#,
            escape(&heading)
        ));
    }

    // Through the sign-in page, which sends a member straight on to the title
    // and offers everyone else an account first. A direct link to /media/ would
    // bring a signed-out reader back here, since the application now sends
    // them to this page.
    let app_link = format!(
        "/login?returnTo=%2Fmedia%2F{}%3Ftype%3D{}",
        row.tmdb_id,
        kind.media_type()
    );
    let structured = structured_data(page, title, overview.map(|(text, _)| text), &url);
    let image = row
        .poster_path
        .as_deref()
        .map(|poster| format!("{IMAGE_BASE}/w780{poster}"))
        .unwrap_or_else(|| format!("{SITE}/og-image.png"));
    let og_type = if kind == Kind::Movie {
        "video.movie"
    } else {
        "video.tv_show"
    };

    format!(
        r#"<!doctype html>
<html lang="{lang}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>{document_title}</title>
<meta name="description" content="{description}" />
<meta name="robots" content="index, follow, max-image-preview:large" />
<link rel="canonical" href="{url}" />
<link rel="alternate" hreflang="ro" href="{SITE}{ro_path}" />
<link rel="alternate" hreflang="en" href="{SITE}{en_path}" />
<link rel="alternate" hreflang="x-default" href="{SITE}{en_path}" />
<meta property="og:type" content="{og_type}" />
<meta property="og:site_name" content="Văzute" />
<meta property="og:locale" content="{og_locale}" />
<meta property="og:title" content="{og_title}" />
<meta property="og:description" content="{description}" />
<meta property="og:url" content="{url}" />
<meta property="og:image" content="{image}" />
<meta name="twitter:card" content="summary_large_image" />
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<link rel="stylesheet" href="/title-page.css" />
<script type="application/ld+json">{structured}</script>
</head>
<body>
<header class="site">
<a class="brand" href="/">Văzute</a>
{nav}
<a class="language" href="{other_path}" hreflang="{other_lang}" lang="{other_lang}">{other_language}</a>
</header>
<main>
<article>
<div class="hero">
{poster}
<div class="heading">
<p class="facts">{facts}</p>
<h1>{heading}</h1>
{original}
{genre_list}
<p><a class="button" href="{app_link}">{add}</a></p>
<p class="tagline">{tagline}</p>
</div>
</div>
{sections}
</article>
</main>
<footer class="site">
<p>{tmdb_notice}</p>
<p><a href="/about">{about_link}</a> · <a href="/privacy">{privacy_link}</a></p>
</footer>
</body>
</html>
"#,
        lang = language.code(),
        document_title = escape(&document_title),
        description = escape(&description),
        url = escape(&url),
        ro_path = escape(&ro_path),
        en_path = escape(&en_path),
        og_locale = if language == Language::Ro {
            "ro_RO"
        } else {
            "en_US"
        },
        og_title = escape(&format!("{title}{heading_year}")),
        image = escape(&image),
        other_path = escape(&other_path),
        other_lang = other.code(),
        other_language = w.other_language,
        nav = crate::routes::hubs::sections_nav(language),
        heading = escape(&format!("{title}{heading_year}")),
        app_link = escape(&app_link),
        add = w.add,
        tagline = w.tagline,
        tmdb_notice = w.tmdb_notice,
        about_link = w.about_link,
        privacy_link = w.privacy_link,
    )
}

pub(crate) fn not_found(language: Language) -> HttpResponse {
    let (title, text, home) = match language {
        Language::Ro => (
            "Titlul nu a fost găsit — Văzute",
            "Nu avem o pagină pentru acest titlu.",
            "Mergi la Văzute",
        ),
        Language::En => (
            "Title not found — Văzute",
            "There is no page for this title.",
            "Go to Văzute",
        ),
    };
    html_page(HttpResponse::NotFound(), "public, max-age=600").body(format!(
        r#"<!doctype html>
<html lang="{lang}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>{title}</title>
<meta name="robots" content="noindex" />
<link rel="stylesheet" href="/title-page.css" />
</head>
<body>
<header class="site"><a class="brand" href="/">Văzute</a></header>
<main><article><h1>{text}</h1><p><a class="button" href="/">{home}</a></p></article></main>
</body>
</html>
"#,
        lang = language.code()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cache_control(response: &HttpResponse) -> &str {
        response
            .headers()
            .get(header::CACHE_CONTROL)
            .unwrap()
            .to_str()
            .unwrap()
    }

    #[test]
    fn html_pages_ask_the_cdn_not_to_rewrite_them() {
        let page = html_page(HttpResponse::Ok(), "public, max-age=3600").finish();
        assert_eq!(cache_control(&page), "public, max-age=3600, no-transform");
        assert_eq!(
            page.headers().get(header::CONTENT_TYPE).unwrap(),
            "text/html; charset=utf-8"
        );
        assert_eq!(
            cache_control(&not_found(Language::En)),
            "public, max-age=600, no-transform"
        );
    }

    #[test]
    fn every_html_response_starts_from_html_page() {
        // A page that sets its own content type also sets its own caching, and
        // the four pages that did so forgot `no-transform` (see `html_page`).
        let needle = concat!(".content_type(", "\"text/html");
        let routes = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/routes");
        let mut found = Vec::new();
        for entry in std::fs::read_dir(&routes).unwrap() {
            let path = entry.unwrap().path();
            let source = std::fs::read_to_string(&path).unwrap();
            for _ in source.matches(needle) {
                found.push(path.file_name().unwrap().to_string_lossy().into_owned());
            }
        }
        assert_eq!(
            found,
            ["title_pages.rs"],
            "only html_page may set an HTML content type"
        );
    }

    fn row() -> TitleRow {
        TitleRow {
            id: Uuid::nil(),
            tmdb_id: 550,
            title: "Fight Club".to_string(),
            original_title: Some("Fight Club".to_string()),
            overview: Some("An insomniac office worker.\nA second paragraph.".to_string()),
            poster_path: Some("/poster.jpg".to_string()),
            release_date: NaiveDate::from_ymd_opt(1999, 10, 15),
            status: Some("Released".to_string()),
            genres: Some(json!([{"id": 18, "name": "Drama"}, {"id": 99999, "name": "Unknown"}])),
            runtime_minutes: Some(139),
            ro_title: Some("Clubul luptătorilor".to_string()),
            ro_overview: None,
        }
    }

    fn page(language: Language, kind: Kind) -> Page {
        Page {
            language,
            kind,
            row: row(),
            seasons: Vec::new(),
            next_episode: None,
            romanian_releases: vec![(3, NaiveDate::from_ymd_opt(1999, 11, 26).unwrap())],
            related: vec![Related {
                tmdb_id: 807,
                title: "Se7en".to_string(),
                ro_title: Some("Seven: Cele șapte păcate capitale".to_string()),
                release_date: NaiveDate::from_ymd_opt(1995, 9, 22),
            }],
            providers: Some(WatchProvidersResponse {
                region: "RO".to_string(),
                link: Some("https://www.themoviedb.org/movie/550/watch?locale=RO".to_string()),
                stream: vec![WatchProviderEntry {
                    provider_id: 8,
                    name: "Netflix".to_string(),
                    logo_path: Some("/netflix.png".to_string()),
                }],
                rent: Vec::new(),
                buy: Vec::new(),
            }),
        }
    }

    #[test]
    fn slugs_fold_romanian_letters_and_drop_punctuation() {
        assert_eq!(slugify("Clubul luptătorilor"), "clubul-luptatorilor");
        assert_eq!(slugify("Băieți răi: Șase țânci!"), "baieti-rai-sase-tanci");
        assert_eq!(
            slugify("  Spider-Man: No Way Home  "),
            "spider-man-no-way-home"
        );
        assert_eq!(slugify("千と千尋の神隠し"), "");
        assert!(slugify(&"word ".repeat(40)).len() <= 84);
    }

    #[test]
    fn a_title_without_a_latin_slug_is_addressed_by_its_id() {
        assert_eq!(
            page_path(Language::Ro, Kind::Movie, 129, "千と千尋の神隠し"),
            "/ro/film/129"
        );
        assert_eq!(
            page_path(Language::En, Kind::Tv, 1399, "Game of Thrones"),
            "/en/tv/1399-game-of-thrones"
        );
    }

    #[test]
    fn only_a_leading_positive_id_is_accepted() {
        assert_eq!(parse_id("550-fight-club"), Some(550));
        assert_eq!(parse_id("550"), Some(550));
        assert_eq!(parse_id("fight-club"), None);
        assert_eq!(parse_id("0-zero"), None);
        assert_eq!(parse_id("99999999999-big"), None);
        assert_eq!(parse_id("-550"), None);
    }

    #[test]
    fn a_romanian_page_names_itself_and_its_english_twin() {
        let html = render(&page(Language::Ro, Kind::Movie));
        assert!(html.contains(r#"<html lang="ro">"#));
        assert!(html.contains(
            r#"<link rel="canonical" href="https://vazute.micutu.com/ro/film/550-clubul-luptatorilor" />"#
        ));
        assert!(html
            .contains(r#"hreflang="en" href="https://vazute.micutu.com/en/movie/550-fight-club""#));
        assert!(html.contains(
            r#"hreflang="x-default" href="https://vazute.micutu.com/en/movie/550-fight-club""#
        ));
        assert!(html.contains("<h1>Clubul luptătorilor (1999)</h1>"));
        assert!(html.contains("Film · 1999 · 2 h 19 min"));
        // A known genre links to its list; one TMDB added later keeps its own
        // name, unlinked, rather than vanishing.
        assert!(html.contains(r#"<li><a href="/ro/filme/drama">Dramă</a></li>"#));
        assert!(html.contains(r#"<nav class="sections"><a href="/ro/filme">Filme</a> <a href="/ro/seriale">Seriale</a> <a href="/ro/seriale/episoade-noi">Episoade noi</a></nav>"#));
        assert!(html.contains("<li>Unknown</li>"));
        assert!(html.contains("Titlu original: <span lang=\"\">Fight Club</span>"));
        assert!(html.contains("<strong>La cinema:</strong> 26 noiembrie 1999"));
    }

    #[test]
    fn an_english_synopsis_on_a_romanian_page_says_what_language_it_is() {
        let html = render(&page(Language::Ro, Kind::Movie));
        assert!(html.contains(
            r#"<p lang="en">An insomniac office worker.</p><p lang="en">A second paragraph.</p>"#
        ));

        let mut translated = page(Language::Ro, Kind::Movie);
        translated.row.ro_overview = Some("Un funcționar cu insomnii.".to_string());
        let html = render(&translated);
        assert!(html.contains("<p>Un funcționar cu insomnii.</p>"));
        assert!(
            html.contains(r#"<meta name="description" content="Un funcționar cu insomnii." />"#)
        );
    }

    #[test]
    fn availability_names_the_providers_and_credits_justwatch() {
        let html = render(&page(Language::Ro, Kind::Movie));
        assert!(html.contains("Unde poți vedea online în România — Clubul luptătorilor"));
        assert!(html.contains("<h3>Abonament sau gratuit</h3>"));
        assert!(html.contains("<span>Netflix</span>"));
        assert!(html.contains("Date despre disponibilitate furnizate de JustWatch."));

        let mut nowhere = page(Language::En, Kind::Movie);
        nowhere.providers = Some(WatchProvidersResponse {
            region: "RO".to_string(),
            link: None,
            stream: Vec::new(),
            rent: Vec::new(),
            buy: Vec::new(),
        });
        assert!(
            render(&nowhere).contains("not currently listed on any streaming service in Romania")
        );

        let mut unknown = page(Language::En, Kind::Movie);
        unknown.providers = None;
        assert!(render(&unknown).contains("Availability could not be checked right now"));
    }

    #[test]
    fn a_series_lists_its_seasons_and_next_episode() {
        let mut series = page(Language::En, Kind::Tv);
        series.row.status = Some("Returning Series".to_string());
        series.seasons = vec![SeasonRow {
            season_number: 1,
            episode_count: Some(10),
            air_date: NaiveDate::from_ymd_opt(2011, 4, 17),
        }];
        series.next_episode = Some(NextEpisode {
            season_number: 2,
            episode_number: 1,
            name: Some("The North <Remembers>".to_string()),
            air_date: NaiveDate::from_ymd_opt(2026, 11, 2).unwrap(),
        });
        let html = render(&series);
        assert!(html.contains("TV series · 1999 · Returning series"));
        assert!(html.contains(
            "<strong>Next episode:</strong> S02E01 — The North &lt;Remembers&gt;, November 2, 2026"
        ));
        assert!(html.contains("<li>Season 1 · 10 episodes · April 17, 2011</li>"));
        assert!(html.contains(r#""@type":"TVSeries""#));
        assert!(html.contains(r#""numberOfSeasons":1"#));
    }

    #[test]
    fn catalogue_text_cannot_break_out_of_the_markup_or_the_script() {
        let mut hostile = page(Language::En, Kind::Movie);
        hostile.row.title = r#"</script><script>alert(1)</script>"#.to_string();
        hostile.row.overview = Some(r#""><img src=x onerror=alert(1)>"#.to_string());
        let html = render(&hostile);
        assert!(!html.contains("<script>alert(1)"));
        assert!(!html.contains("<img src=x"));
        // Inside the JSON-LD block the title is still the same JSON string.
        assert!(html.contains(r#"\u003c/script\u003e\u003cscript\u003ealert(1)"#));
    }

    #[test]
    fn the_movie_structured_data_carries_its_runtime_and_date() {
        let html = render(&page(Language::En, Kind::Movie));
        assert!(html.contains(r#""@type":"Movie""#));
        assert!(html.contains(r#""duration":"PT2H19M""#));
        assert!(html.contains(r#""datePublished":"1999-10-15""#));
    }

    #[test]
    fn a_page_links_to_others_of_its_genre_in_its_own_language() {
        let html = render(&page(Language::Ro, Kind::Movie));
        assert!(html.contains("<h2>Alte filme din genul Dramă</h2>"));
        assert!(html.contains(
            r#"<li><a href="/ro/film/807-seven-cele-sapte-pacate-capitale">Seven: Cele șapte păcate capitale (1995)</a></li>"#
        ));
        let html = render(&page(Language::En, Kind::Movie));
        assert!(html.contains("<h2>More Drama movies</h2>"));
        assert!(html.contains(r#"<a href="/en/movie/807-se7en">Se7en (1995)</a>"#));

        let mut alone = page(Language::En, Kind::Movie);
        alone.related.clear();
        assert!(!render(&alone).contains("More Drama"));
    }

    #[test]
    fn the_call_to_action_goes_through_sign_in() {
        let html = render(&page(Language::En, Kind::Movie));
        assert!(html.contains(r#"href="/login?returnTo=%2Fmedia%2F550%3Ftype%3Dmovie""#));
    }

    #[test]
    fn runtimes_read_naturally_in_both_languages() {
        assert_eq!(format_runtime(45, Language::Ro), "45 min");
        assert_eq!(format_runtime(120, Language::Ro), "2 h");
        assert_eq!(format_runtime(139, Language::En), "2h 19m");
    }
}
