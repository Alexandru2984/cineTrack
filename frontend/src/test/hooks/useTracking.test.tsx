import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useUpdateTracking } from '@/hooks/useTracking';

const patch = vi.fn();

vi.mock('@/lib/api', () => ({
  default: {
    patch: (...args: unknown[]) => patch(...args),
  },
}));

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe('useUpdateTracking', () => {
  beforeEach(() => {
    patch.mockReset();
    patch.mockResolvedValue({ data: { id: 'tracking-1', status: 'completed' } });
  });

  // Completing a show writes watch history for every aired episode on the
  // server. Without these two keys the episode list and the progress bars keep
  // showing the pre-completion state until the page is reloaded by hand.
  it('invalidates the episode watch state after a status change', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidate = vi.spyOn(client, 'invalidateQueries');

    const { result } = renderHook(() => useUpdateTracking(), {
      wrapper: wrapper(client),
    });
    result.current.mutate({ id: 'tracking-1', status: 'completed' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const invalidated = invalidate.mock.calls.map(
      ([options]) => (options?.queryKey as string[])?.[0],
    );
    expect(invalidated).toContain('watched-episodes');
    expect(invalidated).toContain('show-watch-progress');
    expect(invalidated).toContain('tracking');
  });
});
