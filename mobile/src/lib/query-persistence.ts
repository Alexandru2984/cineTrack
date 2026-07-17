import AsyncStorage from '@react-native-async-storage/async-storage';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';

import { shouldPersistQueryKey } from '@/lib/query-cache-policy';

export const QUERY_CACHE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
export const QUERY_CACHE_BUSTER = 'vazute-mobile-cache-v1';

export const queryPersister = createAsyncStoragePersister({
  storage: AsyncStorage,
  key: 'vazute.query-cache',
  throttleTime: 1_000,
});

export const queryDehydrateOptions = {
  shouldDehydrateQuery: (query: {
    queryKey: readonly unknown[];
    state: { status: string; data: unknown };
  }) =>
    query.state.status === 'success' &&
    query.state.data !== undefined &&
    shouldPersistQueryKey(query.queryKey),
};
