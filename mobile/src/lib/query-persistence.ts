import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import type { QueryClient } from '@tanstack/react-query';

import { encryptedQueryStorage } from '@/lib/encrypted-query-storage';
import {
  PERSISTED_QUERY_ROOTS,
  shouldPersistQueryKey,
} from '@/lib/query-cache-policy';

export const QUERY_CACHE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
export const QUERY_CACHE_BUSTER = 'vazute-mobile-cache-v2-encrypted';

export const queryPersister = createAsyncStoragePersister({
  storage: encryptedQueryStorage,
  key: 'vazute.query-cache',
  throttleTime: 1_000,
});

export async function clearOfflineQueryCache(
  queryClient?: Pick<QueryClient, 'removeQueries'>,
) {
  if (queryClient) {
    for (const root of PERSISTED_QUERY_ROOTS) {
      queryClient.removeQueries({ queryKey: [root] });
    }
  }
  await queryPersister.removeClient();
}

export const queryDehydrateOptions = {
  shouldDehydrateQuery: (query: {
    queryKey: readonly unknown[];
    state: { status: string; data: unknown };
  }) =>
    query.state.status === 'success' &&
    query.state.data !== undefined &&
    shouldPersistQueryKey(query.queryKey),
};
