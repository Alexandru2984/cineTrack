//! Metadata for links people share.
//!
//! Every deep link into Văzute unfurled identically. Sending a list to a friend
//! on WhatsApp, a film on Discord or a profile on Facebook produced the same
//! card: "Văzute — track what you watch", with the same generic image, because
//! every route serves one `index.html` and unfurlers do not run JavaScript.
//! Nothing on the receiving end ever showed what was actually sent.
//!
//! For an application nobody pays to advertise, a shared link is the way people
//! arrive. These handlers render the small amount of HTML an unfurler reads —
//! title, description, image — from the same data the page itself would show.
//!
//! # What they will not disclose
//!
//! Visibility is decided here, not inherited. A private list and a list that
//! does not exist produce the same generic card, because a card naming a
//! private list would leak it to anyone who guessed a URL — and unfurlers are
//! exactly the kind of client that fetches a URL somebody merely pasted.

use actix_web::{web, HttpResponse};
use sqlx::PgPool;
use uuid::Uuid;

use crate::errors::AppError;
use crate::routes::title_pages::{escape, html_page, shorten};

/// The same routes, carrying the shared budget.
///
/// These are public, unauthenticated, and each one runs a query. They sit
/// outside `/api`, so the scope that wraps the shared limiter never covered
/// them, and the vhost locations that rewrite here carry no `limit_req` of
/// their own — the crawler match is a `User-Agent`, which anyone can send. That
/// left three routes doing database work for anybody who asked, as fast as they
/// could ask.
///
/// The budget is the ordinary shared one. A preview crawler fetches a link
/// once, and the services that fetch a few times come from different addresses,
/// so this is not a limit real unfurling can reach.
pub fn configure_rate_limited(
    cfg: &mut web::ServiceConfig,
    limiter: &crate::routes::SharedGovernorConfig,
) {
    cfg.service(
        web::scope("/unfurl")
            .wrap(crate::middleware::rate_limit::RateLimit::new(limiter))
            .route("/list/{id}", web::get().to(list_card))
            .route("/list/{id}", web::head().to(list_card))
            .route("/media/{tmdb_id}", web::get().to(media_card))
            .route("/media/{tmdb_id}", web::head().to(media_card))
            .route("/profile/{username}", web::get().to(profile_card))
            .route("/profile/{username}", web::head().to(profile_card)),
    );
}

pub fn configure(cfg: &mut web::ServiceConfig) {
    // HEAD as well as GET. Some preview services ask for the headers first, to
    // see the content type and size before spending a body fetch. Registering
    // only GET answered those with 404 — and because the vhost sends a crawler
    // here and a reader to the application, `HEAD /media/550` returned 404 to a
    // crawler and 200 to a browser, on the same URL. A previewer that checks
    // before it fetches would give up at that point, which is the whole feature
    // failing for exactly the clients it exists to serve.
    //
    // Actix drops the body from a HEAD response itself, so the same handler is
    // correct for both.
    cfg.service(
        web::scope("/unfurl")
            .route("/list/{id}", web::get().to(list_card))
            .route("/list/{id}", web::head().to(list_card))
            .route("/media/{tmdb_id}", web::get().to(media_card))
            .route("/media/{tmdb_id}", web::head().to(media_card))
            .route("/profile/{username}", web::get().to(profile_card))
            .route("/profile/{username}", web::head().to(profile_card)),
    );
}

const SITE: &str = "https://vazute.micutu.com";
const DEFAULT_TITLE: &str = "Văzute — track what you watch";
const DEFAULT_DESCRIPTION: &str =
    "A personal movie and TV tracker: watchlist, episode tracking, release calendar and statistics.";

/// A title's card shows its poster, the one picture that says which film was
/// sent; the site's generic image is for a title TMDB has none for.
fn media_image(poster_path: Option<&str>) -> String {
    match poster_path.filter(|path| {
        path.starts_with('/')
            && path.len() > 1
            && path[1..]
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    }) {
        Some(path) => format!("https://image.tmdb.org/t/p/w780{path}"),
        None => format!("{SITE}/og-image.png"),
    }
}

struct Card {
    title: String,
    description: String,
    url: String,
    image: String,
}

impl Card {
    /// The generic card. Used for anything private, missing, or not ours to
    /// describe — the three must be indistinguishable from outside.
    fn generic(path: &str) -> Self {
        Card {
            title: DEFAULT_TITLE.to_string(),
            description: DEFAULT_DESCRIPTION.to_string(),
            url: format!("{SITE}{path}"),
            image: format!("{SITE}/og-image.png"),
        }
    }
}

/// The document an unfurler reads.
///
/// It carries a real link to the page rather than an automatic redirect: a
/// person who somehow lands here should still get where they were going, and a
/// crawler should see one destination rather than a bounce.
fn render(card: &Card) -> String {
    let title = escape(&card.title);
    let description = escape(&card.description);
    let url = escape(&card.url);
    let image = escape(&card.image);

    format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>{title}</title>
<meta name="description" content="{description}" />
<link rel="canonical" href="{url}" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="Văzute" />
<meta property="og:title" content="{title}" />
<meta property="og:description" content="{description}" />
<meta property="og:url" content="{url}" />
<meta property="og:image" content="{image}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="{title}" />
<meta name="twitter:description" content="{description}" />
<meta name="twitter:image" content="{image}" />
</head>
<body><p><a href="{url}">{title}</a></p></body>
</html>"#
    )
}

fn html(card: Card) -> HttpResponse {
    // `private`, not `public`. This address answers a reader with the
    // application and a preview crawler with this card, so a shared cache
    // that stored one response under the plain URL would hand it to the
    // other: a reader served a bare card, or a crawler served a shell it
    // cannot read. Cloudflare reports these pages as DYNAMIC today, but the
    // response should not be asking to be cached in the first place.
    //
    // `Vary` states the same thing in the terms a well-behaved intermediary
    // reads, and the short lifetime still spares the database when one
    // service fetches a link several times.
    html_page(HttpResponse::Ok(), "private, max-age=300")
        .insert_header(("Vary", "User-Agent"))
        .body(render(&card))
}

async fn list_card(
    pool: web::Data<PgPool>,
    path: web::Path<Uuid>,
) -> Result<HttpResponse, AppError> {
    let id = path.into_inner();
    let found = sqlx::query_as::<_, (String, Option<String>, i64)>(
        r#"SELECT lists.name,
                  lists.description,
                  (SELECT COUNT(*) FROM list_items WHERE list_items.list_id = lists.id)
        FROM lists
        WHERE lists.id = $1 AND lists.is_public"#,
    )
    .bind(id)
    .fetch_optional(pool.get_ref())
    .await?;

    let path = format!("/lists/{id}");
    let Some((name, description, items)) = found else {
        // Private and missing look the same on purpose.
        return Ok(html(Card::generic(&path)));
    };

    let summary = description
        .filter(|text| !text.trim().is_empty())
        .unwrap_or_else(|| {
            if items == 1 {
                "A list of one title on Văzute.".to_string()
            } else {
                format!("A list of {items} titles on Văzute.")
            }
        });

    Ok(html(Card {
        title: format!("{name} — Văzute"),
        description: shorten(&summary, 200),
        url: format!("{SITE}{path}"),
        image: format!("{SITE}/og-image.png"),
    }))
}

#[derive(serde::Deserialize)]
struct MediaCardQuery {
    #[serde(rename = "type")]
    media_type: Option<String>,
}

/// The kind a shared link names, the way the media page reads it: `?type=tv`
/// is a series, and anything else — including no type at all — a film.
fn card_media_type(requested: Option<&str>) -> &'static str {
    match requested {
        Some("tv") => "tv",
        _ => "movie",
    }
}

async fn media_card(
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
    query: web::Query<MediaCardQuery>,
) -> Result<HttpResponse, AppError> {
    let tmdb_id = path.into_inner();
    // TMDB numbers films and series separately, so one id names both — 550 is
    // Fight Club and also a 1966 sitcom. The card used to take whichever row
    // was touched last and ignore `?type=`, so a shared film could unfurl as an
    // unrelated series. The link's own type decides, as it does in the app.
    let media_type = card_media_type(query.media_type.as_deref());
    let found = sqlx::query_as::<
        _,
        (
            String,
            Option<String>,
            Option<chrono::NaiveDate>,
            String,
            Option<String>,
        ),
    >(
        r#"SELECT title, overview, release_date, media_type, poster_path
        FROM media
        WHERE tmdb_id = $1 AND media_type = $2"#,
    )
    .bind(tmdb_id)
    .bind(media_type)
    .fetch_optional(pool.get_ref())
    .await?;

    let Some((title, overview, release_date, media_type, poster_path)) = found else {
        return Ok(html(Card::generic(&format!(
            "/media/{tmdb_id}?type={media_type}"
        ))));
    };

    let path = format!("/media/{tmdb_id}?type={media_type}");
    let year = release_date
        .map(|date| format!(" ({})", date.format("%Y")))
        .unwrap_or_default();
    let summary = overview
        .filter(|text| !text.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_DESCRIPTION.to_string());

    Ok(html(Card {
        title: format!("{title}{year} — Văzute"),
        description: shorten(&summary, 200),
        url: format!("{SITE}{path}"),
        image: media_image(poster_path.as_deref()),
    }))
}

async fn profile_card(
    pool: web::Data<PgPool>,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let username = path.into_inner();
    let found = sqlx::query_as::<_, (String, Option<String>)>(
        r#"SELECT username, bio
        FROM users
        WHERE LOWER(username) = LOWER($1) AND is_public"#,
    )
    .bind(&username)
    .fetch_optional(pool.get_ref())
    .await?;

    let path = format!("/profile/{username}");
    let Some((name, bio)) = found else {
        // A private account is not advertised, not even by name.
        return Ok(html(Card::generic(&path)));
    };

    let summary = bio
        .filter(|text| !text.trim().is_empty())
        .unwrap_or_else(|| format!("{name} on Văzute."));

    Ok(html(Card {
        title: format!("{name} — Văzute"),
        description: shorten(&summary, 200),
        url: format!("{SITE}/profile/{name}"),
        image: format!("{SITE}/og-image.png"),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markup_from_a_hostile_name_cannot_break_out_of_an_attribute() {
        let card = Card {
            title: r#"</title><script>alert(1)</script>"#.to_string(),
            description: r#"a " onload="evil()"#.to_string(),
            url: format!("{SITE}/lists/1"),
            image: format!("{SITE}/og-image.png"),
        };
        let html = render(&card);

        assert!(
            !html.contains("<script>"),
            "a list name must not become markup"
        );
        assert!(
            !html.contains(r#"" onload=""#),
            "a quote must not open an attribute"
        );
        assert!(html.contains("&lt;script&gt;"));
    }

    #[test]
    fn a_link_without_a_series_type_is_a_film() {
        assert_eq!(card_media_type(Some("tv")), "tv");
        assert_eq!(card_media_type(Some("movie")), "movie");
        assert_eq!(card_media_type(None), "movie");
        assert_eq!(card_media_type(Some("person")), "movie");
    }

    #[test]
    fn a_title_card_shows_its_poster() {
        assert_eq!(
            media_image(Some("/pB8BM7pdSp6B6Ih7QZ4DrQ3PmJK.jpg")),
            "https://image.tmdb.org/t/p/w780/pB8BM7pdSp6B6Ih7QZ4DrQ3PmJK.jpg"
        );
        // No poster, or one that is not a plain TMDB file name, falls back.
        for path in [
            None,
            Some(""),
            Some("/"),
            Some("//evil.example/x.jpg"),
            Some("/a\"b.jpg"),
        ] {
            assert_eq!(
                media_image(path),
                "https://vazute.micutu.com/og-image.png",
                "{path:?}"
            );
        }
    }

    #[test]
    fn ampersands_are_escaped_once() {
        // Escaping `&` after `<` would turn `&lt;` into `&amp;lt;` and show the
        // entity to the reader instead of the character.
        assert_eq!(escape("Tom & Jerry <b>"), "Tom &amp; Jerry &lt;b&gt;");
    }

    #[test]
    fn a_long_description_is_cut_on_a_word() {
        let text = "the quick brown fox jumps over the lazy dog";
        let short = shorten(text, 20);
        assert!(short.ends_with('…'));
        assert!(short.chars().count() <= 21);
        assert!(!short.contains("  "));
        assert!(text.starts_with(short.trim_end_matches('…')));
    }

    #[test]
    fn a_short_description_is_left_alone() {
        assert_eq!(shorten("already short", 200), "already short");
    }

    #[test]
    fn whitespace_from_a_pasted_description_is_collapsed() {
        assert_eq!(shorten("two\n\nlines   here", 200), "two lines here");
    }

    #[actix_web::test]
    async fn a_card_is_never_stored_by_a_cache_shared_with_readers() {
        // The same URL serves the application to a reader and this card to a
        // preview crawler. A shared cache holding either one under the plain
        // address would serve it to the wrong client.
        let response = html(Card::generic("/media/550"));

        let cache_control = response
            .headers()
            .get("Cache-Control")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_string();
        assert!(
            !cache_control.contains("public"),
            "a card must not invite a shared cache to store it, got {cache_control:?}"
        );
        assert!(cache_control.contains("private"), "got {cache_control:?}");
        assert_eq!(
            response
                .headers()
                .get("Vary")
                .and_then(|value| value.to_str().ok()),
            Some("User-Agent"),
            "the response depends on the user agent and must say so"
        );
    }

    #[test]
    fn the_generic_card_says_nothing_about_what_was_asked_for() {
        let card = Card::generic("/lists/9d9a1f2e");
        assert_eq!(card.title, DEFAULT_TITLE);
        // The URL is the one that was requested, but nothing else identifies it:
        // a private list and a missing one must be indistinguishable.
        assert!(card.url.ends_with("/lists/9d9a1f2e"));
        assert!(!card.description.contains("9d9a1f2e"));
    }
}
