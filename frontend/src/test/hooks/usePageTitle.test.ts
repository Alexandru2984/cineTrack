import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { usePageTitle } from '@/hooks/usePageTitle';

const DEFAULT = 'Văzute — track what you watch';

describe('usePageTitle', () => {
  afterEach(() => {
    document.title = '';
  });

  it('sets a page-scoped title and restores the default on unmount', () => {
    const { unmount } = renderHook(() => usePageTitle('The Matrix'));
    expect(document.title).toBe('The Matrix — Văzute');
    unmount();
    expect(document.title).toBe(DEFAULT);
  });

  it('falls back to the default title when no page title is given', () => {
    renderHook(() => usePageTitle(null));
    expect(document.title).toBe(DEFAULT);
  });
});
