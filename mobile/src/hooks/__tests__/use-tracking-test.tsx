import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { useUpdateTracking, useWatchlistPreview } from '@/hooks/use-tracking';

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
