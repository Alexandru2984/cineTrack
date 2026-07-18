import { describe, expect, it } from 'vitest';
// Vite `?raw` import — works in vitest and at type-check without node types.
import html from '../../../index.html?raw';

// Static crawlers only read the meta baked into index.html, so guard the core
// Open Graph / Twitter tags and the social image against accidental removal.
describe('index.html social meta', () => {
  it('declares Open Graph and Twitter Card tags', () => {
    expect(html).toContain('property="og:title"');
    expect(html).toContain('property="og:description"');
    expect(html).toContain('property="og:type"');
    expect(html).toContain('name="twitter:card" content="summary_large_image"');
  });

  it('points at the absolute social image', () => {
    expect(html).toContain('property="og:image" content="https://vazute.micutu.com/og-image.png"');
    expect(html).toContain('name="twitter:image" content="https://vazute.micutu.com/og-image.png"');
  });
});
