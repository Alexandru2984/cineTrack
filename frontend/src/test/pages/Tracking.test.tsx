import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import TrackingPage from '@/pages/Tracking';

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  resetUpdate: vi.fn(),
  remove: vi.fn(),
  fetchNextPage: vi.fn(),
  listFilters: vi.fn(),
  facetFilters: vi.fn(),
  exportLibrary: vi.fn(),
}));

vi.mock('@/hooks/useTracking', () => ({
  useTrackingFacets: (filters: unknown, language: string) => {
    mocks.facetFilters(filters, language);
    return {
      data: {
        total: 1,
        statuses: { completed: 1, watching: 3 },
        media_types: { movie: 1 },
        genres: [
          { id: 16, name: 'Animation', count: 3 },
          { id: 18, name: 'Drama', count: 1 },
        ],
        anime: 2,
        favorites: 0,
      },
    };
  },
  useTrackingInfinite: (filters: unknown) => (mocks.listFilters(filters), {
    data: {
      pages: [[{
        id: 'tracking-1',
        media_id: 'media-1',
        tmdb_id: 42,
        media_type: 'movie',
        title: 'Test Movie',
        poster_path: null,
        status: 'completed',
        rating: 7,
        review: 'Original review',
        is_favorite: false,
        started_at: null,
        completed_at: null,
        release_date: '2019-05-30',
      }]],
      pageParams: [1],
    },
    isLoading: false,
    isError: false,
    hasNextPage: true,
    isFetchingNextPage: false,
    fetchNextPage: mocks.fetchNextPage,
    refetch: vi.fn(),
  }),
  useUpdateTracking: () => ({
    mutate: mocks.update,
    reset: mocks.resetUpdate,
    isPending: false,
    error: null,
  }),
  useDeleteTracking: () => ({ mutate: mocks.remove }),
  useExportLibrary: () => ({ mutate: mocks.exportLibrary, isPending: false, isError: false }),
}));

describe('Tracking rating and review editor', () => {
  beforeEach(() => vi.clearAllMocks());

  it('updates a rating and trims the review', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><TrackingPage /></MemoryRouter>);

    await user.click(screen.getByRole('button', { name: 'Edit rating and review for Test Movie' }));
    expect(screen.getByRole('dialog', { name: 'Your rating and review' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Increase rating' }));
    const review = screen.getByRole('textbox', { name: 'Review' });
    await user.clear(review);
    await user.type(review, '  Better on a second viewing.  ');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(mocks.update).toHaveBeenCalledWith(
      {
        id: 'tracking-1',
        rating: 8,
        review: 'Better on a second viewing.',
      },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it('sends nulls when feedback is cleared', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><TrackingPage /></MemoryRouter>);

    await user.click(screen.getByRole('button', { name: 'Edit rating and review for Test Movie' }));
    await user.click(screen.getByRole('button', { name: 'Clear rating' }));
    await user.clear(screen.getByRole('textbox', { name: 'Review' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(mocks.update).toHaveBeenCalledWith(
      { id: 'tracking-1', rating: null, review: null },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it('loads the next library page on demand', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><TrackingPage /></MemoryRouter>);

    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(mocks.fetchNextPage).toHaveBeenCalledOnce();
  });
});

function Address() {
  const location = useLocation();
  return <output aria-label="address">{location.search}</output>;
}

function renderAt(search = '') {
  return render(
    <MemoryRouter initialEntries={[`/tracking${search}`]}>
      <TrackingPage />
      <Address />
    </MemoryRouter>,
  );
}

const lastListFilters = () => mocks.listFilters.mock.calls.at(-1)?.[0];

describe('Tracking filters', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads the filters from the address and shows what each choice leaves', () => {
    renderAt('?status=watching&type=tv&genre=anime&favorite=1&sort=title&q=naruto&genre_bogus=1');

    expect(lastListFilters()).toEqual({
      status: 'watching',
      mediaType: 'tv',
      genre: 'anime',
      favorite: true,
      q: 'naruto',
      sort: 'title',
    });
    expect(mocks.facetFilters).toHaveBeenLastCalledWith(lastListFilters(), 'en');
    expect(screen.getByRole('tab', { name: 'Watching 3' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'All 4' })).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Genre' })).toHaveValue('anime');
    expect(screen.getByRole('option', { name: 'Anime (2)' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Animation (3)' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Series (0)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Favorites only (0)' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('searchbox', { name: 'Search your library' })).toHaveValue('naruto');
    expect(screen.getByText('1 title')).toBeVisible();
    expect(screen.getByText('2019')).toBeVisible();
  });

  it('ignores values it does not know', () => {
    renderAt('?status=bogus&type=anime&genre=Animation&sort=popularity&favorite=yes');
    expect(lastListFilters()).toEqual({});
  });

  it('writes each choice to the address and clears them all at once', async () => {
    const user = userEvent.setup();
    renderAt('?status=completed');

    await user.selectOptions(screen.getByRole('combobox', { name: 'Genre' }), 'Animation (3)');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Type' }), 'Movies (1)');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Sort by' }), 'My rating');
    await user.click(screen.getByRole('button', { name: 'Favorites only (0)' }));
    expect(screen.getByLabelText('address')).toHaveTextContent(
      '?status=completed&genre=16&type=movie&sort=rating&favorite=1',
    );
    expect(lastListFilters()).toEqual({
      status: 'completed',
      genre: '16',
      mediaType: 'movie',
      sort: 'rating',
      favorite: true,
    });

    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    // The status tab and the order are where the person is, not filters.
    expect(screen.getByLabelText('address')).toHaveTextContent('?status=completed&sort=rating');
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();
  });

  it('exports the list as it is filtered and ordered', async () => {
    const user = userEvent.setup();
    renderAt('?status=completed&genre=anime&sort=title');

    await user.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(mocks.exportLibrary).toHaveBeenCalledWith({
      filters: { status: 'completed', genre: 'anime', sort: 'title' },
      language: 'en',
    });
  });

  it('searches once typing pauses', async () => {
    const user = userEvent.setup();
    renderAt();

    await user.type(screen.getByRole('searchbox', { name: 'Search your library' }), 'one piece ');
    expect(screen.getByRole('searchbox', { name: 'Search your library' })).toHaveValue('one piece ');
    await waitFor(() => expect(screen.getByLabelText('address')).toHaveTextContent('?q=one+piece'));
    // The address catching up does not trim the box under the cursor.
    expect(screen.getByRole('searchbox', { name: 'Search your library' })).toHaveValue('one piece ');
    expect(lastListFilters()).toEqual({ q: 'one piece' });
  });
});
