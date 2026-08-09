import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';

import { useCanonicalUrl } from '@/hooks/useCanonicalUrl';

function at(path: string) {
  return ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
  );
}

function canonical() {
  return document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href;
}

describe('useCanonicalUrl', () => {
  afterEach(() => {
    document.querySelector('link[rel="canonical"]')?.remove();
  });

  // The bug this guards: index.html ships a canonical pointing at the site
  // root, so every route used to declare itself a duplicate of the home page.
  it('claims the current route rather than the site root', () => {
    renderHook(() => useCanonicalUrl(), { wrapper: at('/terms') });
    expect(canonical()).toBe('https://vazute.micutu.com/terms');
  });

  it('keeps the root path intact', () => {
    renderHook(() => useCanonicalUrl(), { wrapper: at('/') });
    expect(canonical()).toBe('https://vazute.micutu.com/');
  });

  it('ignores query strings and fragments, which select within a page', () => {
    renderHook(() => useCanonicalUrl(), {
      wrapper: at('/about?ref=twitter#team'),
    });
    expect(canonical()).toBe('https://vazute.micutu.com/about');
  });

  it('drops a trailing slash so one page cannot claim two addresses', () => {
    renderHook(() => useCanonicalUrl(), { wrapper: at('/privacy/') });
    expect(canonical()).toBe('https://vazute.micutu.com/privacy');
  });

  it('reuses the tag already in the document instead of adding another', () => {
    const existing = document.createElement('link');
    existing.rel = 'canonical';
    existing.href = 'https://vazute.micutu.com/';
    document.head.appendChild(existing);

    renderHook(() => useCanonicalUrl(), { wrapper: at('/about') });

    expect(document.querySelectorAll('link[rel="canonical"]')).toHaveLength(1);
    expect(canonical()).toBe('https://vazute.micutu.com/about');
  });
});
