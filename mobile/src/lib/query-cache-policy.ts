export const PERSISTED_QUERY_ROOTS = [
  'calendar',
  'discovery',
  'episode',
  'episodes',
  'media',
  'seasons',
  'show-progress',
  'tracking',
  'watched-episodes',
] as const;

const persistedRoots = new Set<string>(PERSISTED_QUERY_ROOTS);

export function shouldPersistQueryKey(queryKey: readonly unknown[]) {
  const root = queryKey[0];
  return typeof root === 'string' && persistedRoots.has(root);
}
