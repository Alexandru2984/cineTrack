import { shouldPersistQueryKey } from '@/lib/query-cache-policy';

describe('offline query cache policy', () => {
  it('keeps core viewing data available offline', () => {
    expect(shouldPersistQueryKey(['tracking', undefined, 'infinite'])).toBe(true);
    expect(shouldPersistQueryKey(['calendar', 'up-next', '2026-07-17', 10])).toBe(true);
    expect(shouldPersistQueryKey(['history', 'list'])).toBe(true);
    expect(shouldPersistQueryKey(['lists', 'mine'])).toBe(true);
  });

  it('does not persist account, notification, or social queries', () => {
    expect(shouldPersistQueryKey(['account-sessions'])).toBe(false);
    expect(shouldPersistQueryKey(['notifications', 'list'])).toBe(false);
    expect(shouldPersistQueryKey(['social', 'feed'])).toBe(false);
    expect(shouldPersistQueryKey(['users', 'search', 'alex'])).toBe(false);
  });
});
