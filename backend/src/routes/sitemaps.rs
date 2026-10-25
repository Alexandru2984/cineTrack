//! The sitemaps that list the public title pages.
//!
//! `/sitemap.xml` was a static file of the eight pages a signed-out visitor
//! could read. With a page for every catalogued title there are thousands, and
//! the number grows with every catalogue hydration, so the list is built from
//! the same rows the pages are: `/sitemap.xml` is now an index naming the
//! static pages' file (`/sitemap-pages.xml`, still served by the frontend) and
//! one file per language and slice of titles here.
//!
//! Each entry names its other-language twin with `xhtml:link`, the sitemap
//! form of the `hreflang` links the pages carry, and its `lastmod` is when the
//! title's data was last refreshed from TMDB — a date that means something,
//! unlike the hand-written ones the static file declined to carry.

use actix_web::{web, HttpResponse};
use chrono::{DateTime, Utc};
use sqlx::PgPool;

use crate::errors::AppError;
use crate::routes::hubs::{genre_counts, hub_path, listed_genres};
use crate::routes::title_pages::{page_path, Kind, Language};

const SITE: &str = "https://vazute.micutu.com";
/// URLs per file. The protocol allows 50,000; a smaller slice keeps each
/// response quick to build and to fetch.
const PER_FILE: i64 = 10_000;

pub fn configure_rate_limited(
    cfg: &mut web::ServiceConfig,
    limiter: &crate::routes::SharedGovernorConfig,
) {
    cfg.service(index().wrap(crate::middleware::rate_limit::RateLimit::new(limiter)));
    cfg.service(files().wrap(crate::middleware::rate_limit::RateLimit::new(limiter)));
}

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(index());
    cfg.service(files());
}

fn index() -> actix_web::Resource {
    web::resource("/sitemap.xml")
        .route(web::get().to(sitemap_index))
        .route(web::head().to(sitemap_index))
}

fn files() -> actix_web::Scope {
    web::scope("/sitemaps")
        .route("/{file}", web::get().to(title_sitemap))
        .route("/{file}", web::head().to(title_sitemap))
}

fn xml(body: String) -> HttpResponse {
    HttpResponse::Ok()
        .content_type("application/xml; charset=utf-8")
        .insert_header(("Cache-Control", "public, max-age=3600"))
        .body(body)
}

fn not_found() -> HttpResponse {
    HttpResponse::NotFound()
        .content_type("text/plain; charset=utf-8")
        .body("Not found")
}

/// How many files each language's titles fill.
fn file_count(titles: i64) -> i64 {
    (titles + PER_FILE - 1) / PER_FILE
}

async fn sitemap_index(pool: web::Data<PgPool>) -> Result<HttpResponse, AppError> {
    let (titles, newest) = sqlx::query_as::<_, (i64, Option<DateTime<Utc>>)>(
        // The condition a title must meet to have a page, as in `title_pages`.
        "SELECT COUNT(*), MAX(m.tmdb_cached_at) FROM media m \
         WHERE m.metadata_level = 'detail' AND m.popularity IS NOT NULL",
    )
    .fetch_one(pool.get_ref())
    .await?;
    Ok(xml(render_index(titles, newest)))
}

fn render_index(titles: i64, newest: Option<DateTime<Utc>>) -> String {
    let lastmod = newest
        .map(|date| format!("<lastmod>{}</lastmod>", date.format("%Y-%m-%d")))
        .unwrap_or_default();
    let mut entries = format!(
        "<sitemap><loc>{SITE}/sitemap-pages.xml</loc></sitemap>\n\
         <sitemap><loc>{SITE}/sitemaps/lists.xml</loc>{lastmod}</sitemap>\n"
    );
    for language in ["ro", "en"] {
        for file in 1..=file_count(titles) {
            entries.push_str(&format!(
                "<sitemap><loc>{SITE}/sitemaps/titles-{language}-{file}.xml</loc>{lastmod}</sitemap>\n"
            ));
        }
    }
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <sitemapindex xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n\
         {entries}</sitemapindex>\n"
    )
}

/// `titles-ro-3.xml` → (Romanian, 3).
fn parse_file(name: &str) -> Option<(Language, i64)> {
    let rest = name.strip_prefix("titles-")?.strip_suffix(".xml")?;
    let (language, number) = rest.split_once('-')?;
    let language = match language {
        "ro" => Language::Ro,
        "en" => Language::En,
        _ => return None,
    };
    if number.is_empty() || number.len() > 6 || !number.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let number = number.parse::<i64>().ok().filter(|number| *number >= 1)?;
    Some((language, number))
}

struct Entry {
    tmdb_id: i32,
    kind: Kind,
    title: String,
    ro_title: Option<String>,
    refreshed: DateTime<Utc>,
}

async fn title_sitemap(
    pool: web::Data<PgPool>,
    file: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    if file.as_str() == "lists.xml" {
        return lists_sitemap(pool).await;
    }
    let Some((language, number)) = parse_file(&file) else {
        return Ok(not_found());
    };

    let rows = sqlx::query_as::<_, (i32, String, String, Option<String>, DateTime<Utc>)>(
        r#"SELECT m.tmdb_id, m.media_type, m.title, l.title, m.tmdb_cached_at
        FROM media m
        LEFT JOIN media_localizations l
          ON l.media_id = m.id AND l.language_code = 'ro'
        WHERE m.metadata_level = 'detail' AND m.popularity IS NOT NULL
        ORDER BY m.media_type, m.tmdb_id
        LIMIT $1 OFFSET $2"#,
    )
    .bind(PER_FILE)
    .bind((number - 1) * PER_FILE)
    .fetch_all(pool.get_ref())
    .await?;
    if rows.is_empty() {
        return Ok(not_found());
    }

    let entries = rows
        .into_iter()
        .filter_map(|(tmdb_id, media_type, title, ro_title, refreshed)| {
            let kind = match media_type.as_str() {
                "movie" => Kind::Movie,
                "tv" => Kind::Tv,
                _ => return None,
            };
            Some(Entry {
                tmdb_id,
                kind,
                title,
                ro_title,
                refreshed,
            })
        })
        .collect::<Vec<_>>();
    Ok(xml(render_titles(language, &entries)))
}

/// The popularity and genre lists, in both languages, each naming its twin.
async fn lists_sitemap(pool: web::Data<PgPool>) -> Result<HttpResponse, AppError> {
    let mut lists = Vec::new();
    for kind in [Kind::Movie, Kind::Tv] {
        let counts = genre_counts(pool.get_ref(), kind).await?;
        lists.push((kind, None));
        lists.extend(
            listed_genres(kind, &counts)
                .into_iter()
                .map(|genre| (kind, Some(genre))),
        );
    }
    let mut pairs = lists
        .into_iter()
        .map(|(kind, genre)| {
            (
                format!("{SITE}{}", hub_path(Language::Ro, kind, genre)),
                format!("{SITE}{}", hub_path(Language::En, kind, genre)),
            )
        })
        .collect::<Vec<_>>();
    pairs.push((
        format!("{SITE}{}", crate::routes::new_episodes::path(Language::Ro)),
        format!("{SITE}{}", crate::routes::new_episodes::path(Language::En)),
    ));
    let mut urls = String::new();
    for (ro, en) in pairs {
        for loc in [&ro, &en] {
            urls.push_str(&format!(
                "<url><loc>{loc}</loc>\
                 <xhtml:link rel=\"alternate\" hreflang=\"ro\" href=\"{ro}\"/>\
                 <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"{en}\"/>\
                 <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"{en}\"/></url>\n",
                loc = escape(loc),
                ro = escape(&ro),
                en = escape(&en),
            ));
        }
    }
    Ok(xml(format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\" \
         xmlns:xhtml=\"http://www.w3.org/1999/xhtml\">\n\
         {urls}</urlset>\n"
    )))
}

/// Escape for XML text.
fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn render_titles(language: Language, entries: &[Entry]) -> String {
    let mut urls = String::new();
    for entry in entries {
        let romanian = entry.ro_title.as_deref().unwrap_or(&entry.title);
        let ro = format!(
            "{SITE}{}",
            page_path(Language::Ro, entry.kind, entry.tmdb_id, romanian)
        );
        let en = format!(
            "{SITE}{}",
            page_path(Language::En, entry.kind, entry.tmdb_id, &entry.title)
        );
        let loc = match language {
            Language::Ro => &ro,
            Language::En => &en,
        };
        urls.push_str(&format!(
            "<url><loc>{loc}</loc><lastmod>{lastmod}</lastmod>\
             <xhtml:link rel=\"alternate\" hreflang=\"ro\" href=\"{ro}\"/>\
             <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"{en}\"/>\
             <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"{en}\"/></url>\n",
            loc = escape(loc),
            lastmod = entry.refreshed.format("%Y-%m-%d"),
            ro = escape(&ro),
            en = escape(&en),
        ));
    }
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\" \
         xmlns:xhtml=\"http://www.w3.org/1999/xhtml\">\n\
         {urls}</urlset>\n"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn the_index_names_the_static_pages_and_every_title_file() {
        let newest = Utc.with_ymd_and_hms(2026, 10, 19, 8, 0, 0).single();
        let index = render_index(PER_FILE + 1, newest);
        assert!(index.contains("<loc>https://vazute.micutu.com/sitemap-pages.xml</loc>"));
        assert!(index.contains("<loc>https://vazute.micutu.com/sitemaps/lists.xml</loc>"));
        for file in ["titles-ro-1", "titles-ro-2", "titles-en-1", "titles-en-2"] {
            assert!(
                index.contains(&format!(
                    "<loc>https://vazute.micutu.com/sitemaps/{file}.xml</loc><lastmod>2026-10-19</lastmod>"
                )),
                "{file}"
            );
        }
        assert!(!index.contains("titles-ro-3"));
        assert!(!render_index(0, None).contains("titles-"));
    }

    #[test]
    fn only_well_formed_file_names_are_accepted() {
        assert_eq!(parse_file("titles-ro-1.xml"), Some((Language::Ro, 1)));
        assert_eq!(parse_file("titles-en-12.xml"), Some((Language::En, 12)));
        for name in [
            "titles-de-1.xml",
            "titles-ro-0.xml",
            "titles-ro-.xml",
            "titles-ro-1",
            "titles-ro-x.xml",
            "titles-ro-1234567.xml",
            "pages.xml",
        ] {
            assert_eq!(parse_file(name), None, "{name}");
        }
    }

    #[test]
    fn each_entry_names_its_twin_in_the_other_language() {
        let entries = [Entry {
            tmdb_id: 1399,
            kind: Kind::Tv,
            title: "Game of Thrones".to_string(),
            ro_title: Some("Urzeala tronurilor".to_string()),
            refreshed: Utc.with_ymd_and_hms(2026, 10, 18, 22, 0, 0).unwrap(),
        }];
        let ro = render_titles(Language::Ro, &entries);
        assert!(ro.contains(
            "<url><loc>https://vazute.micutu.com/ro/serial/1399-urzeala-tronurilor</loc><lastmod>2026-10-18</lastmod>"
        ));
        assert!(ro.contains(
            r#"<xhtml:link rel="alternate" hreflang="en" href="https://vazute.micutu.com/en/tv/1399-game-of-thrones"/>"#
        ));
        let en = render_titles(Language::En, &entries);
        assert!(en.contains("<loc>https://vazute.micutu.com/en/tv/1399-game-of-thrones</loc>"));
        assert!(en.contains(
            r#"hreflang="ro" href="https://vazute.micutu.com/ro/serial/1399-urzeala-tronurilor"/>"#
        ));
    }

    #[test]
    fn file_counts_round_up() {
        assert_eq!(file_count(0), 0);
        assert_eq!(file_count(1), 1);
        assert_eq!(file_count(PER_FILE), 1);
        assert_eq!(file_count(PER_FILE + 1), 2);
    }
}
