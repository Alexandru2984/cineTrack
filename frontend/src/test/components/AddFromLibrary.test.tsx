import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AddFromLibrary } from '@/components/AddFromLibrary';

/** Why this exists.
 *
 *  An empty list told its owner to "open a movie or show and use Custom list to
 *  add it here" — it sent them away and asked them to come back, once per
 *  title. Across eleven accounts, nobody has ever made a list.
 *
 *  The titles somebody wants in a list are ones they have already tracked, and
 *  those already carry the media id the API wants, so the whole round trip was
 *  avoidable.
 */
const mocks = vi.hoisted(() => ({
  tracking: vi.fn(),
  addMutate: vi.fn(),
  fetchNextPage: vi.fn(),
}));

vi.mock('@/hooks/useTracking', () => ({
  useTrackingInfinite: () => mocks.tracking(),
}));

vi.mock('@/hooks/useLists', () => ({
  useAddListItem: () => ({
    mutate: mocks.addMutate,
    isPending: false,
    error: null,
  }),
}));

function libraryOf(...titles: [string, string][]) {
  return {
    data: {
      pages: [
        titles.map(([media_id, title]) => ({
          id: `tracking-${media_id}`,
          media_id,
          tmdb_id: 1,
          media_type: 'movie',
          title,
          poster_path: null,
          status: 'completed',
          rating: null,
          review: null,
          is_favorite: false,
          started_at: null,
          completed_at: null,
        })),
      ],
    },
    isLoading: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: mocks.fetchNextPage,
  };
}

describe('AddFromLibrary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tracking.mockReturnValue(
      libraryOf(['media-1', 'Arrival'], ['media-2', 'Dune'], ['media-3', 'Heat']),
    );
  });

  it('adds a title with the media id the API expects', async () => {
    const user = userEvent.setup();
    render(<AddFromLibrary listId="list-1" alreadyIn={new Set()} />);

    await user.click(screen.getByRole('button', { name: /dune/i }));

    expect(mocks.addMutate).toHaveBeenCalledWith(
      { listId: 'list-1', mediaId: 'media-2' },
      expect.anything(),
    );
  });

  it('filters the library by title', async () => {
    const user = userEvent.setup();
    render(<AddFromLibrary listId="list-1" alreadyIn={new Set()} />);

    await user.type(screen.getByRole('searchbox'), 'du');

    expect(screen.getByRole('button', { name: /dune/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /arrival/i })).not.toBeInTheDocument();
  });

  it('shows what is already in the list as done rather than offering it again', () => {
    render(<AddFromLibrary listId="list-1" alreadyIn={new Set(['media-1'])} />);

    // The API discards a duplicate with ON CONFLICT DO NOTHING, so offering it
    // would be a button that appears to work and changes nothing.
    expect(screen.getByRole('button', { name: /arrival/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /dune/i })).toBeEnabled();
  });

  it('stops offering a title the moment it has been added', async () => {
    const user = userEvent.setup();
    mocks.addMutate.mockImplementation((_variables, options) => options?.onSuccess?.());
    render(<AddFromLibrary listId="list-1" alreadyIn={new Set()} />);

    const dune = screen.getByRole('button', { name: /dune/i });
    await user.click(dune);

    // The list refetch is not instant. A button that stays live after a
    // successful click invites a second one.
    await waitFor(() => expect(screen.getByRole('button', { name: /dune/i })).toBeDisabled());
  });

  it('loads the rest of the library so the filter covers all of it', () => {
    mocks.tracking.mockReturnValue({
      ...libraryOf(['media-1', 'Arrival']),
      hasNextPage: true,
    });
    render(<AddFromLibrary listId="list-1" alreadyIn={new Set()} />);

    // Filtering one page of a hundred would silently hide the rest of a
    // library from its own search box.
    expect(mocks.fetchNextPage).toHaveBeenCalled();
  });

  it('says the library is empty rather than showing an empty box', () => {
    mocks.tracking.mockReturnValue(libraryOf());
    render(<AddFromLibrary listId="list-1" alreadyIn={new Set()} />);

    expect(screen.getByText(/your library is empty/i)).toBeInTheDocument();
  });

  it('distinguishes an empty library from a filter that matches nothing', async () => {
    const user = userEvent.setup();
    render(<AddFromLibrary listId="list-1" alreadyIn={new Set()} />);

    await user.type(screen.getByRole('searchbox'), 'zzzz');

    expect(screen.getByText(/nothing in your library matches/i)).toBeInTheDocument();
    expect(screen.queryByText(/your library is empty/i)).not.toBeInTheDocument();
  });
});
