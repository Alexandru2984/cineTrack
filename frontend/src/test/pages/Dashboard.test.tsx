import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Dashboard from '@/pages/Dashboard';

const mocks = vi.hoisted(() => ({
  useDiscovery: vi.fn(),
  refetchDiscovery: vi.fn(),
}));

vi.mock('@/hooks/useMedia', () => ({
  useDiscovery: () => mocks.useDiscovery(),
}));

vi.mock('@/hooks/useStats', () => ({
  useMyStats: () => ({ data: undefined }),
  useHeatmap: () => ({ data: [] }),
}));

vi.mock('@/hooks/useSocial', () => ({
  useActivityFeed: () => ({ data: [], isLoading: false, isError: false }),
}));

vi.mock('@/store/auth', () => ({
  useAuthStore: (selector: (state: { user: { username: string } }) => unknown) =>
    selector({ user: { username: 'dashboard-user' } }),
}));

vi.mock('@/components/MediaCard', () => ({
  MediaCard: ({ item }: { item: { title?: string; name?: string } }) => (
    <div>{item.title ?? item.name}</div>
  ),
}));

vi.mock('@/components/ActivityList', () => ({
  ActivityList: () => <div>Activity fixture</div>,
}));

vi.mock('react-calendar-heatmap', () => ({
  default: () => <div>Heatmap fixture</div>,
}));

describe('Dashboard discovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useDiscovery.mockReturnValue({
      data: {
        recommendations: [
          { id: 1, media_type: 'movie', title: 'Alegerea dramatica' },
        ],
        personalized: true,
        recommendation_basis: ['Drama', 'Thriller'],
        popular_movies: [{ id: 2, media_type: 'movie', title: 'Popular Movie' }],
        popular_shows: [{ id: 3, media_type: 'tv', name: 'Popular Show' }],
      },
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: mocks.refetchDiscovery,
    });
  });

  it('renders personalized and popular local shelves', () => {
    render(<Dashboard />);

    expect(screen.getByRole('heading', { name: 'For You' })).toBeVisible();
    expect(screen.getByText('Drama · Thriller')).toBeVisible();
    expect(screen.getByText('Alegerea dramatica')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Popular Movies' })).toBeVisible();
    expect(screen.getByText('Popular Movie')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Popular Shows' })).toBeVisible();
    expect(screen.getByText('Popular Show')).toBeVisible();
  });

  it('renders cold start and retries a failed discovery request', async () => {
    const user = userEvent.setup();
    mocks.useDiscovery.mockReturnValueOnce({
      data: undefined,
      isLoading: false,
      isError: true,
      isFetching: false,
      refetch: mocks.refetchDiscovery,
    });
    const { rerender } = render(<Dashboard />);

    await user.click(screen.getByRole('button', { name: 'Retry recommendations' }));
    expect(mocks.refetchDiscovery).toHaveBeenCalledOnce();

    mocks.useDiscovery.mockReturnValue({
      data: {
        recommendations: [],
        personalized: false,
        recommendation_basis: [],
        popular_movies: [],
        popular_shows: [],
      },
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: mocks.refetchDiscovery,
    });
    rerender(<Dashboard />);

    expect(screen.getByRole('heading', { name: 'Recommended' })).toBeVisible();
    expect(screen.getByText('No recommendations yet')).toBeVisible();
  });
});
