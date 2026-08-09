import { useEffect } from 'react';
import { useLocation } from 'react-router';

/**
 * The one address every page should claim as its own.
 *
 * Hardcoded rather than read from `window.location.origin` so a preview or
 * staging host can never publish itself as the canonical site.
 */
const SITE_ORIGIN = 'https://vazute.micutu.com';

/**
 * Point `<link rel="canonical">` at the current route.
 *
 * `index.html` ships a canonical tag for the site root, and without this every
 * route kept claiming to be that root — telling search engines the terms,
 * privacy and about pages are all duplicates of the home page, which is exactly
 * how a page gets dropped from an index.
 *
 * Query strings and fragments are left out on purpose: they select or scroll
 * within a page rather than identify a different one, so folding them in would
 * split one page into many near-identical entries.
 */
export function useCanonicalUrl() {
  const { pathname } = useLocation();

  useEffect(() => {
    // Keep "/" as-is but drop a trailing slash anywhere else, so "/about" and
    // "/about/" cannot both be advertised as canonical.
    const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : '/';

    let link = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'canonical';
      document.head.appendChild(link);
    }
    link.href = `${SITE_ORIGIN}${path}`;
  }, [pathname]);
}
