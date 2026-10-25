//! New episodes this week: what airs over the next seven days, day by day.
//!
//! The lists answer "seriale populare"; this answers "episoade noi săptămâna
//! aceasta", and it is the one public page that changes every day, which gives
//! a crawler a reason to come back. It is drawn from the episodes the release
//! schedule job caches. That job refreshes every airing series with a page,
//! not only the ones members follow, so the week covers the catalogue.
//!
//! Dates are TMDB's air dates, which are the premiere dates in the country of
//! origin; "today" is today in Romania.

use actix_web::{web, HttpResponse};
use chrono::{Datelike, NaiveDate, Weekday};
use sqlx::PgPool;

use crate::errors::AppError;
use crate::routes::hubs::sections_nav;
use crate::routes::title_pages::{escape, page_path, Kind, Language, IMAGE_BASE, SITE};

/// Days covered, today included.
const DAYS: i32 = 7;
/// Series shown for one day, most popular first.
const PER_DAY: usize = 30;

pub fn path(language: Language) -> &'static str {
    match language {
        Language::Ro => "/ro/seriale/episoade-noi",
        Language::En => "/en/series/new-episodes",
    }
}

pub async fn romanian(pool: web::Data<PgPool>) -> Result<HttpResponse, AppError> {
    page(pool.get_ref(), Language::Ro).await
}

pub async fn english(pool: web::Data<PgPool>) -> Result<HttpResponse, AppError> {
    page(pool.get_ref(), Language::En).await
}

/// One series on one day: a single episode, or several released together.
struct Entry {
    air_date: NaiveDate,
    tmdb_id: i32,
    title: String,
    ro_title: Option<String>,
    poster_path: Option<String>,
    season_number: i32,
    first_episode: i32,
    last_episode: i32,
    episodes: i64,
    first_name: Option<String>,
}

impl Entry {
    fn title_in(&self, language: Language) -> &str {
        match language {
            Language::Ro => self.ro_title.as_deref().unwrap_or(&self.title),
            Language::En => &self.title,
        }
    }
}

type Row = (
    NaiveDate,
    i32,
    String,
    Option<String>,
    Option<String>,
    i32,
    i32,
    i32,
    i64,
    Option<String>,
);

async fn page(pool: &PgPool, language: Language) -> Result<HttpResponse, AppError> {
    let today =
        sqlx::query_scalar::<_, NaiveDate>("SELECT (NOW() AT TIME ZONE 'Europe/Bucharest')::date")
            .fetch_one(pool)
            .await?;
    // News (10763) and talk shows (10767) air every weekday and would fill
    // every day on their own.
    let rows = sqlx::query_as::<_, Row>(
        r#"SELECT e.air_date, m.tmdb_id, m.title, l.title, m.poster_path, s.season_number,
            MIN(e.episode_number), MAX(e.episode_number), COUNT(*),
            (ARRAY_AGG(e.name ORDER BY e.episode_number))[1]
        FROM episodes e
        JOIN seasons s ON s.id = e.season_id
        JOIN media m ON m.id = s.media_id
        LEFT JOIN media_localizations l
          ON l.media_id = m.id AND l.language_code = 'ro'
        WHERE m.media_type = 'tv'
          AND m.metadata_level = 'detail'
          AND m.popularity IS NOT NULL
          AND s.season_number > 0
          AND e.air_date >= $1
          AND e.air_date < $1 + $2::int
          AND NOT COALESCE(
              m.genres @> '[{"id": 10763}]'::jsonb OR m.genres @> '[{"id": 10767}]'::jsonb,
              false
          )
        GROUP BY e.air_date, m.id, m.tmdb_id, m.title, l.title, m.poster_path, m.popularity,
                 s.season_number
        ORDER BY e.air_date, m.popularity DESC, m.tmdb_id, s.season_number"#,
    )
    .bind(today)
    .bind(DAYS)
    .fetch_all(pool)
    .await?;

    let mut days: Vec<(NaiveDate, Vec<Entry>)> = Vec::new();
    for row in rows {
        let entry = Entry {
            air_date: row.0,
            tmdb_id: row.1,
            title: row.2,
            ro_title: row.3,
            poster_path: row.4,
            season_number: row.5,
            first_episode: row.6,
            last_episode: row.7,
            episodes: row.8,
            first_name: row.9,
        };
        match days.last_mut() {
            Some((day, entries)) if *day == entry.air_date => {
                if entries.len() < PER_DAY {
                    entries.push(entry);
                }
            }
            _ => days.push((entry.air_date, vec![entry])),
        }
    }

    Ok(HttpResponse::Ok()
        .content_type("text/html; charset=utf-8")
        .insert_header(("Cache-Control", "public, max-age=3600"))
        .body(render(language, today, &days)))
}

fn weekday(language: Language, day: Weekday) -> &'static str {
    let index = day.num_days_from_monday() as usize;
    match language {
        Language::Ro => [
            "luni",
            "marți",
            "miercuri",
            "joi",
            "vineri",
            "sâmbătă",
            "duminică",
        ][index],
        Language::En => [
            "Monday",
            "Tuesday",
            "Wednesday",
            "Thursday",
            "Friday",
            "Saturday",
            "Sunday",
        ][index],
    }
}

fn month(language: Language, month0: u32) -> &'static str {
    let index = month0 as usize;
    match language {
        Language::Ro => [
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
        ][index],
        Language::En => [
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
        ][index],
    }
}

fn day_heading(language: Language, today: NaiveDate, date: NaiveDate) -> String {
    let long = match language {
        Language::Ro => format!(
            "{}, {} {}",
            weekday(language, date.weekday()),
            date.day(),
            month(language, date.month0())
        ),
        Language::En => format!(
            "{} {} {}",
            weekday(language, date.weekday()),
            date.day(),
            month(language, date.month0())
        ),
    };
    let offset = (date - today).num_days();
    match (language, offset) {
        (Language::Ro, 0) => format!("Azi · {long}"),
        (Language::Ro, 1) => format!("Mâine · {long}"),
        (Language::En, 0) => format!("Today · {long}"),
        (Language::En, 1) => format!("Tomorrow · {long}"),
        _ => {
            let mut chars = long.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().chain(chars).collect(),
                None => long,
            }
        }
    }
}

fn episode_label(language: Language, entry: &Entry) -> String {
    let code = format!("S{:02}E{:02}", entry.season_number, entry.first_episode);
    if entry.episodes > 1 {
        let count = match language {
            Language::Ro => format!("{} episoade", entry.episodes),
            Language::En => format!("{} episodes", entry.episodes),
        };
        format!("{code}–E{:02} · {count}", entry.last_episode)
    } else {
        match entry
            .first_name
            .as_deref()
            .filter(|name| !name.trim().is_empty())
        {
            Some(name) => format!("{code} · {name}"),
            None => code,
        }
    }
}

fn render(language: Language, today: NaiveDate, days: &[(NaiveDate, Vec<Entry>)]) -> String {
    let ro = language == Language::Ro;
    let other = if ro { Language::En } else { Language::Ro };
    let url = format!("{SITE}{}", path(language));
    let (title, intro) = if ro {
        (
            "Episoade noi săptămâna aceasta",
            "Episoadele care apar în următoarele șapte zile, din serialele cele mai căutate pe TMDB. Data este cea a premierei în țara de origine.",
        )
    } else {
        (
            "New episodes this week",
            "The episodes airing over the next seven days, from the series most searched for on TMDB. Dates are premiere dates in the country of origin.",
        )
    };
    let description = format!("{title}. {intro}");
    // An empty week says nothing worth indexing.
    let robots = if days.is_empty() {
        "noindex, follow"
    } else {
        "index, follow, max-image-preview:large"
    };

    let sections = if days.is_empty() {
        let empty = if ro {
            "Nu avem încă episoade programate pentru săptămâna aceasta."
        } else {
            "No episodes are scheduled for this week yet."
        };
        format!(r#"<p class="muted">{empty}</p>"#)
    } else {
        days.iter()
            .map(|(date, entries)| {
                let items = entries
                    .iter()
                    .map(|entry| {
                        let name = entry.title_in(language);
                        let href = page_path(language, Kind::Tv, entry.tmdb_id, name);
                        let poster = entry
                            .poster_path
                            .as_deref()
                            .map(|poster| {
                                format!(
                                    r#"<img src="{IMAGE_BASE}/w92{}" alt="" width="46" height="69" loading="lazy" decoding="async" />"#,
                                    escape(poster)
                                )
                            })
                            .unwrap_or_else(|| r#"<span class="no-poster"></span>"#.to_string());
                        format!(
                            r#"<li><a href="{}">{poster}<span><span class="name">{}</span><span class="episode">{}</span></span></a></li>"#,
                            escape(&href),
                            escape(name),
                            escape(&episode_label(language, entry))
                        )
                    })
                    .collect::<String>();
                format!(
                    r#"<section><h2><time datetime="{date}">{}</time></h2><ul class="schedule">{items}</ul></section>"#,
                    escape(&day_heading(language, today, *date))
                )
            })
            .collect::<String>()
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
<meta name="robots" content="{robots}" />
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
{nav}
<a class="language" href="{other_path}" hreflang="{other_lang}" lang="{other_lang}">{other_language}</a>
</header>
<main>
<article>
<h1>{title}</h1>
<p class="intro">{intro}</p>
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
        description = escape(&description),
        url = escape(&url),
        ro_path = path(Language::Ro),
        en_path = path(Language::En),
        nav = sections_nav(language),
        other_path = path(other),
        other_lang = other.code(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(episodes: i64, name: Option<&str>) -> Entry {
        Entry {
            air_date: NaiveDate::from_ymd_opt(2026, 10, 27).unwrap(),
            tmdb_id: 1399,
            title: "Game of Thrones".to_string(),
            ro_title: Some("Urzeala tronurilor".to_string()),
            poster_path: Some("/p.jpg".to_string()),
            season_number: 2,
            first_episode: 5,
            last_episode: 4 + episodes as i32,
            episodes,
            first_name: name.map(str::to_string),
        }
    }

    #[test]
    fn days_are_named_from_today() {
        let today = NaiveDate::from_ymd_opt(2026, 10, 25).unwrap();
        assert_eq!(
            day_heading(Language::Ro, today, today),
            "Azi · duminică, 25 octombrie"
        );
        assert_eq!(
            day_heading(Language::Ro, today, today.succ_opt().unwrap()),
            "Mâine · luni, 26 octombrie"
        );
        assert_eq!(
            day_heading(
                Language::Ro,
                today,
                NaiveDate::from_ymd_opt(2026, 10, 27).unwrap()
            ),
            "Marți, 27 octombrie"
        );
        assert_eq!(
            day_heading(
                Language::En,
                today,
                NaiveDate::from_ymd_opt(2026, 10, 31).unwrap()
            ),
            "Saturday 31 October"
        );
    }

    #[test]
    fn a_batch_release_reads_as_a_range() {
        assert_eq!(
            episode_label(Language::Ro, &entry(1, Some("The Night Lands"))),
            "S02E05 · The Night Lands"
        );
        assert_eq!(episode_label(Language::En, &entry(1, Some("  "))), "S02E05");
        assert_eq!(
            episode_label(Language::Ro, &entry(8, Some("ignored"))),
            "S02E05–E12 · 8 episoade"
        );
    }

    #[test]
    fn a_romanian_week_links_its_series_in_romanian() {
        let today = NaiveDate::from_ymd_opt(2026, 10, 25).unwrap();
        let days = vec![(entry(1, None).air_date, vec![entry(1, Some("Ep <1>"))])];
        let html = render(Language::Ro, today, &days);
        assert!(html.contains("<h1>Episoade noi săptămâna aceasta</h1>"));
        assert!(html.contains(
            r#"<link rel="canonical" href="https://vazute.micutu.com/ro/seriale/episoade-noi" />"#
        ));
        assert!(html
            .contains(r#"hreflang="en" href="https://vazute.micutu.com/en/series/new-episodes""#));
        assert!(html.contains(r#"<a href="/ro/serial/1399-urzeala-tronurilor">"#));
        assert!(html.contains("S02E05 · Ep &lt;1&gt;"));
        assert!(html.contains(r#"<time datetime="2026-10-27">Marți, 27 octombrie</time>"#));
        assert!(html.contains(r#"content="index, follow, max-image-preview:large""#));
    }

    #[test]
    fn an_empty_week_is_not_indexed() {
        let today = NaiveDate::from_ymd_opt(2026, 10, 25).unwrap();
        let html = render(Language::En, today, &[]);
        assert!(html.contains(r#"<meta name="robots" content="noindex, follow" />"#));
        assert!(html.contains("No episodes are scheduled for this week yet."));
    }
}
