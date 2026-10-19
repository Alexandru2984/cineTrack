//! Lists of titles: the most popular films and series, overall and by genre.
//!
//! A title page answers a search for that title. These answer the broader
//! ones — "filme de groază", "seriale de comedie", "popular movies" — and they
//! are the paths a crawler follows into the catalogue: the home page links
//! here, these link to the titles, and every title page links back to its
//! genre's list.
//!
//! Like the title pages they are published in Romanian and English, rendered
//! here as plain HTML from the rows that have a page of their own. A genre
//! with too few such titles gets no list rather than a thin one.

use actix_web::{web, HttpResponse};
use chrono::{Datelike, NaiveDate};
use sqlx::PgPool;

use crate::errors::AppError;
use crate::routes::title_pages::{escape, page_path, Kind, Language, IMAGE_BASE, SITE};

/// Titles on one list.
const HUB_SIZE: i64 = 60;
/// Below this many titles a genre has no list of its own.
pub const MIN_HUB_TITLES: i64 = 12;

/// A TMDB genre, its names, its addresses, and the kinds it applies to.
pub struct Genre {
    pub id: i32,
    pub ro: &'static str,
    pub en: &'static str,
    ro_slug: &'static str,
    en_slug: &'static str,
    movie: bool,
    tv: bool,
}

impl Genre {
    pub fn name(&self, language: Language) -> &'static str {
        match language {
            Language::Ro => self.ro,
            Language::En => self.en,
        }
    }

    fn slug(&self, language: Language) -> &'static str {
        match language {
            Language::Ro => self.ro_slug,
            Language::En => self.en_slug,
        }
    }

    pub fn applies_to(&self, kind: Kind) -> bool {
        match kind {
            Kind::Movie => self.movie,
            Kind::Tv => self.tv,
        }
    }
}

const fn genre(
    id: i32,
    ro: &'static str,
    en: &'static str,
    ro_slug: &'static str,
    en_slug: &'static str,
    movie: bool,
    tv: bool,
) -> Genre {
    Genre {
        id,
        ro,
        en,
        ro_slug,
        en_slug,
        movie,
        tv,
    }
}

/// TMDB's genres for films and for series. A few ids are shared between the
/// two lists; Romance and History are film genres only, as TMDB defines them.
pub const GENRES: &[Genre] = &[
    genre(28, "Acțiune", "Action", "actiune", "action", true, false),
    genre(
        12,
        "Aventură",
        "Adventure",
        "aventura",
        "adventure",
        true,
        false,
    ),
    genre(
        16,
        "Animație",
        "Animation",
        "animatie",
        "animation",
        true,
        true,
    ),
    genre(35, "Comedie", "Comedy", "comedie", "comedy", true, true),
    genre(80, "Crimă", "Crime", "crima", "crime", true, true),
    genre(
        99,
        "Documentar",
        "Documentary",
        "documentar",
        "documentary",
        true,
        true,
    ),
    genre(18, "Dramă", "Drama", "drama", "drama", true, true),
    genre(10751, "Familie", "Family", "familie", "family", true, true),
    genre(
        14,
        "Fantastic",
        "Fantasy",
        "fantastic",
        "fantasy",
        true,
        false,
    ),
    genre(36, "Istoric", "History", "istoric", "history", true, false),
    genre(27, "Horror", "Horror", "horror", "horror", true, false),
    genre(10402, "Muzical", "Music", "muzical", "music", true, false),
    genre(9648, "Mister", "Mystery", "mister", "mystery", true, true),
    genre(
        10749, "Romantic", "Romance", "romantic", "romance", true, false,
    ),
    genre(
        878,
        "SF",
        "Science Fiction",
        "sf",
        "science-fiction",
        true,
        false,
    ),
    genre(
        10770, "Film TV", "TV Movie", "film-tv", "tv-movie", true, false,
    ),
    genre(
        53, "Thriller", "Thriller", "thriller", "thriller", true, false,
    ),
    genre(10752, "Război", "War", "razboi", "war", true, false),
    genre(37, "Western", "Western", "western", "western", true, true),
    genre(
        10759,
        "Acțiune și aventură",
        "Action & Adventure",
        "actiune-si-aventura",
        "action-and-adventure",
        false,
        true,
    ),
    genre(10762, "Copii", "Kids", "copii", "kids", false, true),
    genre(10763, "Știri", "News", "stiri", "news", false, true),
    genre(
        10764, "Reality", "Reality", "reality", "reality", false, true,
    ),
    genre(
        10765,
        "SF și fantasy",
        "Sci-Fi & Fantasy",
        "sf-si-fantasy",
        "sci-fi-and-fantasy",
        false,
        true,
    ),
    genre(
        10766,
        "Telenovelă",
        "Soap",
        "telenovela",
        "soap",
        false,
        true,
    ),
    genre(10767, "Talk-show", "Talk", "talk-show", "talk", false, true),
    genre(
        10768,
        "Război și politică",
        "War & Politics",
        "razboi-si-politica",
        "war-and-politics",
        false,
        true,
    ),
];

pub fn genre_by_id(id: i32) -> Option<&'static Genre> {
    GENRES.iter().find(|genre| genre.id == id)
}

fn genre_by_slug(language: Language, kind: Kind, slug: &str) -> Option<&'static Genre> {
    GENRES
        .iter()
        .find(|genre| genre.applies_to(kind) && genre.slug(language) == slug)
}

/// The address of a list: popular overall, or popular in one genre.
pub fn hub_path(language: Language, kind: Kind, genre: Option<&Genre>) -> String {
    let base = match (language, kind) {
        (Language::Ro, Kind::Movie) => "/ro/filme",
        (Language::Ro, Kind::Tv) => "/ro/seriale",
        (Language::En, Kind::Movie) => "/en/movies",
        (Language::En, Kind::Tv) => "/en/series",
    };
    match genre {
        Some(genre) => format!("{base}/{}", genre.slug(language)),
        None => base.to_string(),
    }
}

/// Registered inside `title_pages`' language scopes: a scope that matches a
/// prefix answers every path under it, so a second `/ro` scope would never be
/// consulted.
pub fn romanian_routes(scope: actix_web::Scope) -> actix_web::Scope {
    scope
        .route("/filme", web::get().to(ro_movies))
        .route("/filme", web::head().to(ro_movies))
        .route("/filme/{genre}", web::get().to(ro_movies_genre))
        .route("/filme/{genre}", web::head().to(ro_movies_genre))
        .route("/seriale", web::get().to(ro_series))
        .route("/seriale", web::head().to(ro_series))
        .route("/seriale/{genre}", web::get().to(ro_series_genre))
        .route("/seriale/{genre}", web::head().to(ro_series_genre))
}

pub fn english_routes(scope: actix_web::Scope) -> actix_web::Scope {
    scope
        .route("/movies", web::get().to(en_movies))
        .route("/movies", web::head().to(en_movies))
        .route("/movies/{genre}", web::get().to(en_movies_genre))
        .route("/movies/{genre}", web::head().to(en_movies_genre))
        .route("/series", web::get().to(en_series))
        .route("/series", web::head().to(en_series))
        .route("/series/{genre}", web::get().to(en_series_genre))
        .route("/series/{genre}", web::head().to(en_series_genre))
}

type Pool = web::Data<PgPool>;
type GenrePath = web::Path<String>;

async fn ro_movies(pool: Pool) -> Result<HttpResponse, AppError> {
    hub(pool, Language::Ro, Kind::Movie, None).await
}
async fn ro_movies_genre(pool: Pool, genre: GenrePath) -> Result<HttpResponse, AppError> {
    hub(pool, Language::Ro, Kind::Movie, Some(genre.into_inner())).await
}
async fn ro_series(pool: Pool) -> Result<HttpResponse, AppError> {
    hub(pool, Language::Ro, Kind::Tv, None).await
}
async fn ro_series_genre(pool: Pool, genre: GenrePath) -> Result<HttpResponse, AppError> {
    hub(pool, Language::Ro, Kind::Tv, Some(genre.into_inner())).await
}
async fn en_movies(pool: Pool) -> Result<HttpResponse, AppError> {
    hub(pool, Language::En, Kind::Movie, None).await
}
async fn en_movies_genre(pool: Pool, genre: GenrePath) -> Result<HttpResponse, AppError> {
    hub(pool, Language::En, Kind::Movie, Some(genre.into_inner())).await
}
async fn en_series(pool: Pool) -> Result<HttpResponse, AppError> {
    hub(pool, Language::En, Kind::Tv, None).await
}
async fn en_series_genre(pool: Pool, genre: GenrePath) -> Result<HttpResponse, AppError> {
    hub(pool, Language::En, Kind::Tv, Some(genre.into_inner())).await
}

struct Item {
    tmdb_id: i32,
    title: String,
    ro_title: Option<String>,
    release_date: Option<NaiveDate>,
    poster_path: Option<String>,
}

impl Item {
    fn title_in(&self, language: Language) -> &str {
        match language {
            Language::Ro => self.ro_title.as_deref().unwrap_or(&self.title),
            Language::En => &self.title,
        }
    }
}

/// How many titles with a page each genre of one kind holds.
pub async fn genre_counts(pool: &PgPool, kind: Kind) -> Result<Vec<(i32, i64)>, sqlx::Error> {
    sqlx::query_as::<_, (i32, i64)>(
        r#"SELECT (g->>'id')::int, COUNT(*)
        FROM media m, jsonb_array_elements(m.genres) g
        WHERE m.media_type = $1
          AND m.metadata_level = 'detail'
          AND m.popularity IS NOT NULL
          AND jsonb_typeof(m.genres) = 'array'
          AND g ? 'id'
        GROUP BY 1"#,
    )
    .bind(match kind {
        Kind::Movie => "movie",
        Kind::Tv => "tv",
    })
    .fetch_all(pool)
    .await
}

/// The genres of one kind that have a list, in the table's order.
pub fn listed_genres(kind: Kind, counts: &[(i32, i64)]) -> Vec<&'static Genre> {
    GENRES
        .iter()
        .filter(|genre| genre.applies_to(kind))
        .filter(|genre| {
            counts
                .iter()
                .any(|(id, count)| *id == genre.id && *count >= MIN_HUB_TITLES)
        })
        .collect()
}

async fn hub(
    pool: Pool,
    language: Language,
    kind: Kind,
    genre_slug: Option<String>,
) -> Result<HttpResponse, AppError> {
    let genre = match genre_slug.as_deref() {
        Some(slug) => match genre_by_slug(language, kind, slug) {
            Some(genre) => Some(genre),
            None => return Ok(not_found(language)),
        },
        None => None,
    };

    let counts = genre_counts(pool.get_ref(), kind).await?;
    let listed = listed_genres(kind, &counts);
    if let Some(genre) = genre {
        if !listed.iter().any(|other| other.id == genre.id) {
            return Ok(not_found(language));
        }
    }

    let rows = sqlx::query_as::<
        _,
        (
            i32,
            String,
            Option<String>,
            Option<NaiveDate>,
            Option<String>,
        ),
    >(
        r#"SELECT m.tmdb_id, m.title, l.title, m.release_date, m.poster_path
        FROM media m
        LEFT JOIN media_localizations l
          ON l.media_id = m.id AND l.language_code = 'ro'
        WHERE m.media_type = $1
          AND m.metadata_level = 'detail'
          AND m.popularity IS NOT NULL
          AND ($2::int IS NULL OR m.genres @> jsonb_build_array(jsonb_build_object('id', $2::int)))
        ORDER BY m.popularity DESC, m.tmdb_id
        LIMIT $3"#,
    )
    .bind(match kind {
        Kind::Movie => "movie",
        Kind::Tv => "tv",
    })
    .bind(genre.map(|genre| genre.id))
    .bind(HUB_SIZE)
    .fetch_all(pool.get_ref())
    .await?;
    let items = rows
        .into_iter()
        .map(
            |(tmdb_id, title, ro_title, release_date, poster_path)| Item {
                tmdb_id,
                title,
                ro_title,
                release_date,
                poster_path,
            },
        )
        .collect::<Vec<_>>();

    Ok(HttpResponse::Ok()
        .content_type("text/html; charset=utf-8")
        .insert_header(("Cache-Control", "public, max-age=3600"))
        .body(render(language, kind, genre, &listed, &items)))
}

fn heading(language: Language, kind: Kind, genre: Option<&Genre>) -> String {
    match (language, kind, genre) {
        (Language::Ro, Kind::Movie, None) => "Filme populare".to_string(),
        (Language::Ro, Kind::Tv, None) => "Seriale populare".to_string(),
        (Language::En, Kind::Movie, None) => "Popular movies".to_string(),
        (Language::En, Kind::Tv, None) => "Popular series".to_string(),
        (Language::Ro, Kind::Movie, Some(genre)) => {
            format!("Cele mai populare filme din genul {}", genre.ro)
        }
        (Language::Ro, Kind::Tv, Some(genre)) => {
            format!("Cele mai populare seriale din genul {}", genre.ro)
        }
        (Language::En, Kind::Movie, Some(genre)) => format!("Most popular {} movies", genre.en),
        (Language::En, Kind::Tv, Some(genre)) => format!("Most popular {} series", genre.en),
    }
}

fn render(
    language: Language,
    kind: Kind,
    genre: Option<&Genre>,
    listed: &[&'static Genre],
    items: &[Item],
) -> String {
    let other = match language {
        Language::Ro => Language::En,
        Language::En => Language::Ro,
    };
    let ro = language == Language::Ro;
    let path = hub_path(language, kind, genre);
    let (ro_path, en_path) = (
        hub_path(Language::Ro, kind, genre),
        hub_path(Language::En, kind, genre),
    );
    let other_path = hub_path(other, kind, genre);
    let url = format!("{SITE}{path}");
    let heading = heading(language, kind, genre);

    let intro = match (ro, kind) {
        (true, Kind::Movie) => "Filmele cele mai căutate acum pe TMDB. Pentru fiecare găsești rezumatul, data lansării în România și unde îl poți vedea online.",
        (true, Kind::Tv) => "Serialele cele mai căutate acum pe TMDB. Pentru fiecare găsești rezumatul, sezoanele, următorul episod și unde îl poți vedea online în România.",
        (false, Kind::Movie) => "The films most searched for on TMDB right now. Each has its synopsis, its release dates in Romania and where to watch it there.",
        (false, Kind::Tv) => "The series most searched for on TMDB right now. Each has its synopsis, its seasons, the next episode and where to watch it in Romania.",
    };
    let description = format!("{heading}. {intro}");

    let cards = items
        .iter()
        .map(|item| {
            let name = item.title_in(language);
            let href = page_path(language, kind, item.tmdb_id, name);
            let year = item
                .release_date
                .map(|date| format!(r#"<span class="year">{}</span>"#, date.year()))
                .unwrap_or_default();
            let poster = item
                .poster_path
                .as_deref()
                .map(|poster| {
                    format!(
                        r#"<img src="{IMAGE_BASE}/w185{}" alt="" width="185" height="278" loading="lazy" decoding="async" />"#,
                        escape(poster)
                    )
                })
                .unwrap_or_else(|| r#"<span class="no-poster"></span>"#.to_string());
            format!(
                r#"<li><a href="{}">{poster}<span class="name">{}</span>{year}</a></li>"#,
                escape(&href),
                escape(name)
            )
        })
        .collect::<String>();

    let genre_links = listed
        .iter()
        .map(|item| {
            let current = genre.is_some_and(|genre| genre.id == item.id);
            if current {
                format!(
                    r#"<li><span aria-current="page">{}</span></li>"#,
                    escape(item.name(language))
                )
            } else {
                format!(
                    r#"<li><a href="{}">{}</a></li>"#,
                    escape(&hub_path(language, kind, Some(item))),
                    escape(item.name(language))
                )
            }
        })
        .collect::<String>();
    let all_label = match (ro, kind) {
        (true, Kind::Movie) => "Toate filmele populare",
        (true, Kind::Tv) => "Toate serialele populare",
        (false, Kind::Movie) => "All popular movies",
        (false, Kind::Tv) => "All popular series",
    };
    let all_link = if genre.is_some() {
        format!(
            r#"<li><a href="{}">{all_label}</a></li>"#,
            escape(&hub_path(language, kind, None))
        )
    } else {
        String::new()
    };
    let genres_heading = if ro { "Genuri" } else { "Genres" };
    let (movies_label, series_label) = if ro {
        ("Filme", "Seriale")
    } else {
        ("Movies", "Series")
    };
    let other_language = if ro { "English" } else { "Română" };
    let tmdb_notice = if ro {
        "Date despre filme și seriale de la TMDB. Văzute folosește API-ul TMDB, dar nu este aprobat sau certificat de TMDB."
    } else {
        "Film and series data from TMDB. Văzute uses the TMDB API but is not endorsed or certified by TMDB."
    };
    let (about_link, privacy_link) = if ro {
        ("Despre Văzute", "Confidențialitate")
    } else {
        ("About Văzute", "Privacy")
    };

    format!(
        r#"<!doctype html>
<html lang="{lang}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>{title} | Văzute</title>
<meta name="description" content="{description}" />
<meta name="robots" content="index, follow, max-image-preview:large" />
<link rel="canonical" href="{url}" />
<link rel="alternate" hreflang="ro" href="{SITE}{ro_path}" />
<link rel="alternate" hreflang="en" href="{SITE}{en_path}" />
<link rel="alternate" hreflang="x-default" href="{SITE}{en_path}" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="Văzute" />
<meta property="og:title" content="{title}" />
<meta property="og:description" content="{description}" />
<meta property="og:url" content="{url}" />
<meta property="og:image" content="{SITE}/og-image.png" />
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<link rel="stylesheet" href="/title-page.css" />
</head>
<body>
<header class="site">
<a class="brand" href="/">Văzute</a>
<nav class="sections"><a href="{movies_href}">{movies_label}</a> <a href="{series_href}">{series_label}</a></nav>
<a class="language" href="{other_path}" hreflang="{other_lang}" lang="{other_lang}">{other_language}</a>
</header>
<main>
<article>
<h1>{title}</h1>
<p class="intro">{intro}</p>
<ol class="grid">{cards}</ol>
<section><h2>{genres_heading}</h2><ul class="genres">{all_link}{genre_links}</ul></section>
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
        title = escape(&heading),
        description = escape(&description),
        url = escape(&url),
        ro_path = escape(&ro_path),
        en_path = escape(&en_path),
        movies_href = hub_path(language, Kind::Movie, None),
        series_href = hub_path(language, Kind::Tv, None),
        other_path = escape(&other_path),
        other_lang = other.code(),
    )
}

fn not_found(language: Language) -> HttpResponse {
    crate::routes::title_pages::not_found(language)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(tmdb_id: i32, title: &str, ro_title: Option<&str>) -> Item {
        Item {
            tmdb_id,
            title: title.to_string(),
            ro_title: ro_title.map(str::to_string),
            release_date: NaiveDate::from_ymd_opt(2011, 4, 17),
            poster_path: Some("/p.jpg".to_string()),
        }
    }

    #[test]
    fn every_genre_has_distinct_addresses_within_its_kind() {
        for kind in [Kind::Movie, Kind::Tv] {
            for language in [Language::Ro, Language::En] {
                let mut slugs = GENRES
                    .iter()
                    .filter(|genre| genre.applies_to(kind))
                    .map(|genre| genre.slug(language))
                    .collect::<Vec<_>>();
                let total = slugs.len();
                slugs.sort_unstable();
                slugs.dedup();
                assert_eq!(slugs.len(), total, "{kind:?} {language:?}");
                for slug in slugs {
                    assert!(
                        slug.bytes().all(|b| b.is_ascii_lowercase() || b == b'-'),
                        "{slug}"
                    );
                }
            }
        }
    }

    #[test]
    fn a_slug_names_a_genre_only_for_the_kinds_it_applies_to() {
        assert_eq!(
            genre_by_slug(Language::Ro, Kind::Movie, "drama").map(|g| g.id),
            Some(18)
        );
        assert_eq!(
            genre_by_slug(Language::En, Kind::Tv, "kids").map(|g| g.id),
            Some(10762)
        );
        assert!(genre_by_slug(Language::Ro, Kind::Tv, "horror").is_none());
        assert!(genre_by_slug(Language::En, Kind::Movie, "kids").is_none());
        assert!(genre_by_slug(Language::Ro, Kind::Movie, "Drama").is_none());
    }

    #[test]
    fn list_addresses_follow_the_language() {
        let drama = genre_by_id(18);
        assert_eq!(
            hub_path(Language::Ro, Kind::Movie, drama),
            "/ro/filme/drama"
        );
        assert_eq!(hub_path(Language::Ro, Kind::Tv, None), "/ro/seriale");
        assert_eq!(
            hub_path(Language::En, Kind::Tv, genre_by_id(10765)),
            "/en/series/sci-fi-and-fantasy"
        );
        assert_eq!(hub_path(Language::En, Kind::Movie, None), "/en/movies");
    }

    #[test]
    fn a_genre_with_too_few_titles_is_not_listed() {
        let counts = [(18, 500), (36, MIN_HUB_TITLES - 1), (35, MIN_HUB_TITLES)];
        let ids = listed_genres(Kind::Movie, &counts)
            .iter()
            .map(|genre| genre.id)
            .collect::<Vec<_>>();
        assert_eq!(ids, vec![35, 18]);
        // A count for a genre that does not apply to the kind lists nothing.
        assert!(listed_genres(Kind::Tv, &[(27, 900)]).is_empty());
    }

    #[test]
    fn a_romanian_list_links_its_titles_and_its_genres_in_romanian() {
        let items = [item(1399, "Game of Thrones", Some("Urzeala tronurilor"))];
        let listed = listed_genres(Kind::Tv, &[(18, 100), (35, 100)]);
        let html = render(Language::Ro, Kind::Tv, genre_by_id(18), &listed, &items);
        assert!(html.contains("<h1>Cele mai populare seriale din genul Dramă</h1>"));
        assert!(html.contains(
            r#"<link rel="canonical" href="https://vazute.micutu.com/ro/seriale/drama" />"#
        ));
        assert!(html.contains(r#"hreflang="en" href="https://vazute.micutu.com/en/series/drama""#));
        assert!(html.contains(
            r#"<a href="/ro/serial/1399-urzeala-tronurilor"><img src="https://image.tmdb.org/t/p/w185/p.jpg""#
        ));
        assert!(html.contains(
            r#"<span class="name">Urzeala tronurilor</span><span class="year">2011</span>"#
        ));
        assert!(html.contains(r#"<li><span aria-current="page">Dramă</span></li>"#));
        assert!(html.contains(r#"<li><a href="/ro/seriale/comedie">Comedie</a></li>"#));
        assert!(html.contains(r#"<li><a href="/ro/seriale">Toate serialele populare</a></li>"#));
    }

    #[test]
    fn an_english_list_needs_no_romanian_title() {
        let items = [item(550, "Fight Club", None)];
        let html = render(Language::En, Kind::Movie, None, &[], &items);
        assert!(html.contains("<h1>Popular movies</h1>"));
        assert!(html.contains(r#"<a href="/en/movie/550-fight-club">"#));
        assert!(!html.contains("All popular movies"));
    }
}
