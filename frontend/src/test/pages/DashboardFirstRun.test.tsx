import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import Dashboard from '@/pages/Dashboard';

/** What an account with no history is shown.
 *
 *  Of the accounts that signed up here and are not the owner's, five of six
 *  have never marked anything watched. The page they landed on greeted them
 *  with "welcome back", four counters reading zero, an empty Up Next, an empty
 *  recommendations row, an empty activity list and a full year of blank
 *  squares — and never said what to do. The rows of posters underneath were the
 *  only way in, and nothing pointed at them.
 *
 *  These assertions are about that: when there is nothing to summarise, the
 *  page must ask for the first title instead of reporting zero six ways.
 */
const mocks = vi.hoisted(() => ({
  stats: vi.fn(),
  activity: vi.fn(),
  discovery: vi.fn(),
}));

vi.mock('@/hooks/useMedia', () => ({
  useDiscovery: () => mocks.discovery(),
  useDismissRecommendation: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/useStats', () => ({
  useMyStats: () => mocks.stats(),
  useHeatmap: () => ({ data: [] }),
}));

vi.mock('@/hooks/useSocial', () => ({
  useActivityFeed: () => mocks.activity(),
}));

vi.mock('@/hooks/useTracking', () => ({
  useTrackingLookupBatch: () => ({ data: [] }),
}));

vi.mock('@/store/auth', () => ({
  useAuthStore: (selector: (state: { user: { username: string } }) => unknown) =>
    selector({ user: { username: 'gina' } }),
}));

vi.mock('@/components/MediaCard', () => ({
  MediaCard: ({ item }: { item: { title?: string } }) => <div>{item.title}</div>,
}));

vi.mock('@/components/ActivityList', () => ({
  ActivityList: () => <div>Activity fixture</div>,
}));

vi.mock('@/components/UpNextEpisodes', () => ({
  UpNextEpisodes: () => <div>Up Next fixture</div>,
}));

vi.mock('react-calendar-heatmap', () => ({
  default: () => <div>Heatmap fixture</div>,
}));

const EMPTY = {
  total_movies: 0,
  total_shows: 0,
  total_episodes: 0,
  total_hours: 0,
  current_streak: 0,
  longest_streak: 0,
};

function renderDashboard() {
  return render(
    <MemoryRouter>
      <Dashboard />
    </MemoryRouter>,
  );
}

describe('Dashboard on a first visit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.stats.mockReturnValue({ data: EMPTY });
    mocks.activity.mockReturnValue({ data: [], isLoading: false, isError: false });
    mocks.discovery.mockReturnValue({
      data: {
        recommendations: [],
        personalized: false,
        recommendation_basis: [],
        popular_movies: [{ id: 1, media_type: 'movie', title: 'Something popular' }],
        popular_shows: [],
      },
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
    });
  });

  it('asks for the first title instead of reporting zero', () => {
    renderDashboard();

    expect(screen.getByRole('heading', { name: /add something you have watched/i })).toBeInTheDocument();
    const action = screen.getByRole('link', { name: /search for a title/i });
    expect(action).toHaveAttribute('href', '/search');
  });

  it('does not greet a first-time member as though they had been here before', () => {
    renderDashboard();

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/welcome,\s*gina/i);
    expect(screen.getByRole('heading', { level: 1 })).not.toHaveTextContent(/welcome back/i);
  });

  it('drops the sections that can only report nothing', () => {
    renderDashboard();

    // Recommendations with nothing in them are an empty heading.
    expect(screen.queryByRole('heading', { name: /^recommended$/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Activity fixture')).not.toBeInTheDocument();
    expect(screen.queryByText('Heatmap fixture')).not.toBeInTheDocument();
    // Four counters reading zero are a scoreboard of nothing.
    expect(screen.queryByText(/hours watched/i)).not.toBeInTheDocument();
  });

  it('still offers something to browse, which is the way in', () => {
    renderDashboard();

    expect(screen.getByRole('heading', { name: /popular movies/i })).toBeInTheDocument();
    expect(screen.getByText('Something popular')).toBeInTheDocument();
  });

  it('restores the full page as soon as anything is tracked', () => {
    // One episode is enough. The threshold is "has this person started", not
    // an arbitrary amount of activity.
    mocks.stats.mockReturnValue({ data: { ...EMPTY, total_episodes: 1 } });
    renderDashboard();

    expect(screen.queryByRole('heading', { name: /add something you have watched/i })).not.toBeInTheDocument();
    expect(screen.getByText('Heatmap fixture')).toBeInTheDocument();
    expect(screen.getByText(/hours watched/i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/welcome back/i);
  });

  it('keeps the activity feed for someone who follows people but tracks nothing', () => {
    // Activity comes from the people followed, not from own history. CI caught
    // this: the first version of this change keyed every section off the stats
    // summary and hid a feed that had something in it.
    mocks.activity.mockReturnValue({
      data: [{ id: 'a1', username: 'followed_user' }],
      isLoading: false,
      isError: false,
    });
    renderDashboard();

    expect(screen.getByText('Activity fixture')).toBeInTheDocument();
  });

  it('keeps the queue, whose reassurance is the one thing worth saying here', () => {
    // Hiding it needed the stats summary to refresh in lockstep with the
    // queue. It does not, so the panel vanished and came back in the middle of
    // marking an episode watched. CI caught that.
    renderDashboard();

    expect(screen.getByText('Up Next fixture')).toBeInTheDocument();
  });

  it('keeps recommendations that actually have titles in them', () => {
    // The backend can return unpersonalised recommendations to somebody with
    // no history. Hiding a shelf with titles in it is worse than the blank
    // heading this replaces.
    mocks.discovery.mockReturnValue({
      data: {
        recommendations: [{ id: 7, media_type: 'movie', title: 'Recommended anyway' }],
        personalized: false,
        recommendation_basis: [],
        popular_movies: [],
        popular_shows: [],
      },
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
    });
    renderDashboard();

    expect(screen.getByText('Recommended anyway')).toBeInTheDocument();
  });

  it('shows the normal page while the statistics are still loading', () => {
    // Undefined is "not known yet", not "nothing". Treating it as empty would
    // flash the first-run invitation at somebody with a full library.
    mocks.stats.mockReturnValue({ data: undefined });
    renderDashboard();

    expect(screen.queryByRole('heading', { name: /add something you have watched/i })).not.toBeInTheDocument();
    expect(screen.getByText('Heatmap fixture')).toBeInTheDocument();
  });
});
