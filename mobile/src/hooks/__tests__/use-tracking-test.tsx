import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import {
  useTrackingFacets,
  useTrackingInfinite,
  useUpdateTracking,
  useWatchlistPreview,
} from '@/hooks/use-tracking';

const mockApiRequest = jest.fn();

jest.mock('@/lib/api', () => ({
  apiRequest: (...args: unknown[]) => mockApiRequest(...args),
}));

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe('useUpdateTracking', () => {
  beforeEach(() => {
    mockApiRequest.mockReset();
    mockApiRequest.mockResolvedValue({ id: 'tracking-1', status: 'completed' });
  });

  // Completing a show makes the server write watch history for every aired
  // episode. Without these keys the episode list and the season progress bars
  // keep rendering their pre-completion snapshot until the screen is reopened.
  it('invalidates the episode watch state after a status change', async () => {
    // gcTime 0 stops React Query scheduling a cleanup timer that outlives the
    // test and leaves Jest waiting on an open handle.
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
        mutations: { retry: false, gcTime: 0 },
      },
    });
    const invalidate = jest.spyOn(client, 'invalidateQueries');

    const { result } = await renderHook(() => useUpdateTracking(), {
      wrapper: wrapper(client),
    });
    result.current.mutate({ id: 'tracking-1', status: 'completed' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const keys = invalidate.mock.calls.map(
      ([options]) => (options?.queryKey as unknown[] | undefined)?.[0],
    );
    expect(keys).toContain('watched-episodes');
    expect(keys).toContain('show-progress');
    expect(keys).toContain('tracking');

    invalidate.mockRestore();
    client.clear();
    client.unmount();
  });
});

describe('useWatchlistPreview', () => {
  beforeEach(() => {
    mockApiRequest.mockReset();
    mockApiRequest.mockResolvedValue([]);
  });

  // The home shelf must ask for the saved titles and nothing else. A missing
  // status turns it into "everything you track", which is the very confusion
  // the shelf exists to remove.
  it('requests only the plan_to_watch rows, bounded', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });

    const { result } = await renderHook(() => useWatchlistPreview(12), {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [path] = mockApiRequest.mock.calls[0] as [string];
    expect(path).toContain('status=plan_to_watch');
    expect(path).toContain('limit=12');

    client.clear();
    client.unmount();
  });

  // Every tracking mutation invalidates `['tracking']`. The shelf only stays
  // current because its key starts there too.
  it('keys the shelf under the tracking family so mutations refresh it', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });

    const { result } = await renderHook(() => useWatchlistPreview(), {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const keys = client.getQueryCache().getAll().map((query) => query.queryKey);
    expect(keys.some((key) => key[0] === 'tracking')).toBe(true);

    client.clear();
    client.unmount();
  });
});

describe('library filters', () => {
  beforeEach(() => {
    mockApiRequest.mockReset();
  });

  // The app gives `tracking` queries the offline cache's week.
  const WEEK = 7 * 24 * 60 * 60 * 1000;
  function client() {
    return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: WEEK } } });
  }
  // Unmount before clearing: a query whose last observer leaves schedules its
  // collection, and with a week's gcTime that timer keeps Jest from exiting.
  async function done(unmount: () => void | Promise<void>, queryClient: QueryClient) {
    await unmount();
    queryClient.clear();
  }

  it('sends each filter the way the API spells it', async () => {
    mockApiRequest.mockResolvedValue([]);
    const queryClient = client();
    const { result, unmount } = await renderHook(
      () =>
        useTrackingInfinite({
          status: 'completed',
          mediaType: 'tv',
          genre: 'anime',
          favorite: true,
          q: '  one piece ',
          sort: 'title',
        }),
      { wrapper: wrapper(queryClient) },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [path] = mockApiRequest.mock.calls[0] as [string];
    const params = new URLSearchParams(path.split('?')[1]);
    expect(Object.fromEntries(params)).toEqual({
      status: 'completed',
      media_type: 'tv',
      genre: 'anime',
      favorite: 'true',
      q: 'one piece',
      sort: 'title',
      page: '1',
      limit: '100',
    });
    // A search or a genre is not kept for the week the offline cache keeps
    // the library itself.
    const [query] = queryClient.getQueryCache().getAll();
    expect(query.gcTime).toBe(5 * 60 * 1000);
    await done(unmount, queryClient);
  });

  it('keeps the key a plain status view had, so an older offline copy still opens', async () => {
    mockApiRequest.mockResolvedValue([]);
    const queryClient = client();
    const { result, unmount } = await renderHook(
      () => useTrackingInfinite({ status: 'watching', sort: 'updated', q: '  ' }),
      { wrapper: wrapper(queryClient) },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [query] = queryClient.getQueryCache().getAll();
    expect(query.queryKey).toEqual(['tracking', 'watching', 'infinite']);
    expect(query.gcTime).toBe(WEEK);
    expect(mockApiRequest.mock.calls[0][0]).toBe('/tracking?status=watching&page=1&limit=100');
    await done(unmount, queryClient);
  });

  it('asks for the facets in the reader\'s language and without the order', async () => {
    mockApiRequest.mockResolvedValue({
      total: 0, statuses: {}, media_types: {}, genres: [], anime: 0, favorites: 0,
    });
    const queryClient = client();
    const { result, unmount } = await renderHook(
      () => useTrackingFacets({ genre: '16', sort: 'rating' }, 'ro'),
      { wrapper: wrapper(queryClient) },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiRequest.mock.calls[0][0]).toBe('/tracking/facets?genre=16&language=ro');
    await done(unmount, queryClient);
  });
});
