import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { useNoIndex } from '@/hooks/useNoIndex';

function robotsTags() {
  return document.querySelectorAll('meta[name="robots"]');
}

describe('useNoIndex', () => {
  afterEach(() => {
    robotsTags().forEach((tag) => tag.remove());
  });

  it('marks the page as noindex while it is mounted', () => {
    renderHook(() => useNoIndex());
    expect(robotsTags()).toHaveLength(1);
    expect(robotsTags()[0].getAttribute('content')).toBe('noindex');
  });

  // Leaving the tag behind would mark the entire app noindex the moment a
  // visitor mistyped one address and then navigated back.
  it('removes the tag once the page is left', () => {
    const { unmount } = renderHook(() => useNoIndex());
    unmount();
    expect(robotsTags()).toHaveLength(0);
  });
});
