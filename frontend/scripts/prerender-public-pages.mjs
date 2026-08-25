/**
 * Give each public page its own metadata in the HTML that is actually served.
 *
 * Every route shipped the same `index.html`, which meant every URL carried
 * `<link rel="canonical" href="https://vazute.micutu.com/">`. That is not a
 * missed opportunity — it is an instruction telling search engines that
 * /about, /privacy, /terms and the rest are the same page as the homepage and
 * should be dropped from the index. The sitemap listed eight pages while the
 * HTML asked for one.
 *
 * These pages are static text, so the fix does not need rendering: a copy of
 * index.html per route with the right title, description and canonical is
 * enough, and it reaches crawlers that never run JavaScript. The SPA still
 * takes over on load, and `usePageMeta` keeps the tags correct while the reader
 * navigates inside the app.
 *
 * `nginx-spa.conf` already resolves `$uri/`, so /about/index.html is served for
 * /about with no configuration change.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const SITE = 'https://vazute.micutu.com';
const BASE = 'Văzute';
const DIST = path.resolve(import.meta.dirname, '../dist');

/** Written for someone searching, not for the changelog: each line says what
 *  the page answers. English, to match the served `<html lang>`; the Romanian
 *  copy renders client-side from the same route. */
const PAGES = [
  {
    route: 'about',
    title: 'About Văzute',
    description:
      'What Văzute is, who runs it, and how it handles the films and series you track. An independent, ad-free tracker.',
  },
  {
    route: 'privacy',
    title: 'Privacy policy',
    description:
      'What Văzute stores about you, how long it keeps it, who processes it, and how to have it deleted.',
  },
  {
    route: 'terms',
    title: 'Terms of service',
    description:
      'The terms for using Văzute: your account, your content, acceptable use, and how the service may change.',
  },
  {
    route: 'community-guidelines',
    title: 'Community guidelines',
    description:
      'What is expected of members on Văzute, what is not allowed, how reports are handled, and how to appeal.',
  },
  {
    route: 'account-deletion',
    title: 'Delete your account',
    description:
      'How to delete a Văzute account and what is removed with it, from inside the app or from this page.',
  },
  {
    route: 'register',
    title: 'Create an account',
    description:
      'Create a free Văzute account to track the films and series you watch, with a release calendar and statistics.',
  },
  {
    route: 'login',
    title: 'Sign in',
    description: 'Sign in to Văzute to reach your watchlist, calendar and statistics.',
  },
];

/** Replace one attribute inside one specific tag, identified by another of its
 *  attributes. Never a blind global replace: that would rewrite the og:image
 *  URL along with the page URL. */
function setTag(html, marker, attribute, value) {
  const pattern = new RegExp(`(<(?:meta|link)[^>]*${marker}[^>]*${attribute}=")[^"]*(")`, 'i');
  if (!pattern.test(html)) {
    throw new Error(`prerender: found no tag matching ${marker} with ${attribute}`);
  }
  return html.replace(pattern, `$1${value}$2`);
}

/** The whole substitution for one page, separated from the file writing so it
 *  can be asserted on directly. Every tag this touches was wrong before: they
 *  all described the homepage. */
export function renderPageHtml(template, page, site = SITE) {
  const url = `${site}/${page.route}`;
  const title = `${page.title} — ${BASE}`;

  let html = template
    .replace(/<title>[^<]*<\/title>/i, `<title>${title}</title>`)
    .replace(/(<meta\s+name="description"[\s\S]*?content=")[\s\S]*?(")/i, `$1${page.description}$2`);
  html = setTag(html, 'rel="canonical"', 'href', url);
  html = setTag(html, 'property="og:url"', 'content', url);
  html = setTag(html, 'property="og:title"', 'content', title);
  html = setTag(html, 'property="og:description"', 'content', page.description);
  html = setTag(html, 'name="twitter:title"', 'content', title);
  html = setTag(html, 'name="twitter:description"', 'content', page.description);
  return html;
}

export { PAGES };

/** Only when run as a command, so importing this from a test writes nothing. */
if (import.meta.filename === process.argv[1]) {
  const template = await readFile(path.join(DIST, 'index.html'), 'utf8');
  let written = 0;
  for (const page of PAGES) {
    const directory = path.join(DIST, page.route);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'index.html'), renderPageHtml(template, page), 'utf8');
    written += 1;
  }
  console.log(`prerendered metadata for ${written} public page(s)`);
}
