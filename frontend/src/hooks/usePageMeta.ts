import { useEffect } from 'react';

const BASE = 'Văzute';
const SITE = 'https://vazute.micutu.com';
const DEFAULT_TITLE = `${BASE} — track what you watch`;

function setAttribute(selector: string, attribute: string, value: string) {
  const element = document.head.querySelector(selector);
  if (element) element.setAttribute(attribute, value);
}

/**
 * Keep the page's identity correct while the reader moves around inside the app.
 *
 * The served HTML now carries per-page metadata for the public routes, written
 * at build time by `scripts/prerender-public-pages.mjs`. That covers the first
 * load and every crawler that does not run JavaScript. This covers what happens
 * afterwards: client-side navigation replaces the view without touching the
 * document, so without it a reader who clicks from /about to /terms is on a
 * page still claiming to be /about.
 *
 * The canonical link is the part that matters beyond the browser tab. Left
 * pointing at the homepage on every route, it tells search engines that every
 * page is a duplicate of the homepage and should be dropped — which is what it
 * did, on every page, while the sitemap asked for eight of them.
 */
export function usePageMeta({
  title,
  description,
  path,
}: {
  title?: string | null;
  /** Omit to keep whatever the served HTML declared. */
  description?: string;
  /** Route path, leading slash included. Omit on pages whose address should not
   *  be advertised as canonical — a private list, say. */
  path?: string;
}) {
  useEffect(() => {
    const full = title ? `${title} — ${BASE}` : DEFAULT_TITLE;
    document.title = full;
    setAttribute('meta[property="og:title"]', 'content', full);
    setAttribute('meta[name="twitter:title"]', 'content', full);

    if (description) {
      setAttribute('meta[name="description"]', 'content', description);
      setAttribute('meta[property="og:description"]', 'content', description);
      setAttribute('meta[name="twitter:description"]', 'content', description);
    }

    if (path) {
      const url = `${SITE}${path}`;
      setAttribute('link[rel="canonical"]', 'href', url);
      setAttribute('meta[property="og:url"]', 'content', url);
    }

    return () => {
      document.title = DEFAULT_TITLE;
    };
  }, [title, description, path]);
}
