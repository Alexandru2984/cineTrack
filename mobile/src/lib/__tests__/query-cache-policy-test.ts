import { shouldPersistQueryKey } from '@/lib/query-cache-policy';

describe('offline query cache policy', () => {
  it('keeps core viewing data available offline', () => {
    expect(shouldPersistQueryKey(['tracking', undefined, 'infinite'])).toBe(true);
    expect(shouldPersistQueryKey(['calendar', 'up-next', '2026-07-17', 10])).toBe(true);
    expect(shouldPersistQueryKey(['episode', 42])).toBe(true);
    expect(shouldPersistQueryKey(['watched-episodes', 100, 2])).toBe(true);
  });

  it('excludes sensitive or nonessential personal data', () => {
    expect(shouldPersistQueryKey(['history', 'list'])).toBe(false);
    expect(shouldPersistQueryKey(['lists', 'mine'])).toBe(false);
    expect(shouldPersistQueryKey(['stats', 'heatmap', 2026])).toBe(false);
    expect(shouldPersistQueryKey(['account-sessions'])).toBe(false);
    expect(shouldPersistQueryKey(['notifications', 'list'])).toBe(false);
    expect(shouldPersistQueryKey(['social', 'feed'])).toBe(false);
    expect(shouldPersistQueryKey(['users', 'search', 'alex'])).toBe(false);
  });
});
