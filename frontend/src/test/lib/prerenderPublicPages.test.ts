import { describe, expect, it } from 'vitest';

import { PAGES, renderPageHtml } from '../../../scripts/prerender-public-pages.mjs';

/** What this guards.
 *
 *  Every route used to ship the same index.html, so every URL carried
 *  `<link rel="canonical" href="https://vazute.micutu.com/">`. That is not a
 *  missed opportunity — it tells a search engine that /about, /privacy, /terms
 *  and the rest are the same page as the homepage and should be dropped. The
 *  sitemap asked for eight pages while the HTML asked for one.
 *
 *  Confirmed live before the fix: all six public pages returned an identical
 *  title and an identical canonical pointing at `/`.
 */
const TEMPLATE = `<!doctype html>
<html lang="en">
  <head>
    <title>Văzute — track what you watch</title>
    <meta
      name="description"
      content="Track the movies and TV shows you watch."
    />
    <link rel="canonical" href="https://vazute.micutu.com/" />
    <meta property="og:type" content="website" />
    <meta property="og:title" content="Văzute — track what you watch" />
    <meta property="og:description" content="A personal movie and TV tracker." />
    <meta property="og:url" content="https://vazute.micutu.com/" />
    <meta property="og:image" content="https://vazute.micutu.com/og-image.png" />
    <meta name="twitter:title" content="Văzute — track what you watch" />
    <meta name="twitter:description" content="A personal movie and TV tracker." />
    <meta name="twitter:image" content="https://vazute.micutu.com/og-image.png" />
  </head>
  <body><div id="root"></div></body>
</html>`;

const page = { route: 'about', title: 'About Văzute', description: 'What Văzute is.' };

function attribute(html: string, marker: string, name: string): string | undefined {
  const match = new RegExp(`<(?:meta|link)[^>]*${marker}[^>]*${name}="([^"]*)"`, 'i').exec(html);
  return match?.[1];
}

describe('prerenderPublicPages', () => {
  it('points the canonical at the page itself, not the homepage', () => {
    const html = renderPageHtml(TEMPLATE, page);

    expect(attribute(html, 'rel="canonical"', 'href')).toBe('https://vazute.micutu.com/about');
    expect(attribute(html, 'property="og:url"', 'content')).toBe(
      'https://vazute.micutu.com/about',
    );
  });

  it('gives the page its own title and description everywhere they appear', () => {
    const html = renderPageHtml(TEMPLATE, page);

    expect(/<title>About Văzute — Văzute<\/title>/.test(html)).toBe(true);
    expect(attribute(html, 'name="description"', 'content')).toBe('What Văzute is.');
    expect(attribute(html, 'property="og:title"', 'content')).toBe('About Văzute — Văzute');
    expect(attribute(html, 'name="twitter:description"', 'content')).toBe('What Văzute is.');
  });

  it('leaves the share image alone', () => {
    const html = renderPageHtml(TEMPLATE, page);

    // The obvious implementation replaces every occurrence of the site URL and
    // silently rewrites og:image to the page address, which then unfurls as a
    // broken preview everywhere the link is posted.
    expect(attribute(html, 'property="og:image"', 'content')).toBe(
      'https://vazute.micutu.com/og-image.png',
    );
    expect(attribute(html, 'name="twitter:image"', 'content')).toBe(
      'https://vazute.micutu.com/og-image.png',
    );
  });

  it('refuses rather than writing a page whose tags it could not find', () => {
    // A silent no-op here would put the old homepage canonical back on every
    // page, which is the exact failure this replaced — and nothing would say so.
    expect(() => renderPageHtml('<html><head></head></html>', page)).toThrow(/canonical/i);
  });

  it('declares a distinct canonical for every page it generates', () => {
    const canonicals = PAGES.map((entry) =>
      attribute(renderPageHtml(TEMPLATE, entry), 'rel="canonical"', 'href'),
    );

    expect(new Set(canonicals).size).toBe(PAGES.length);
    expect(canonicals).not.toContain('https://vazute.micutu.com/');
  });

  it('describes each page differently, since duplicates are what search engines drop', () => {
    const descriptions = PAGES.map((entry) => entry.description);
    expect(new Set(descriptions).size).toBe(PAGES.length);
  });
});
