import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AddToListDialog } from '@/components/AddToListDialog';

const mocks = vi.hoisted(() => ({
  add: vi.fn(),
}));

vi.mock('@/hooks/useLists', () => ({
  useMyLists: () => ({
    data: [
      {
        id: 'list-1',
        name: 'Favorites',
        description: null,
        is_public: false,
        item_count: 3,
        created_at: '2026-01-01T00:00:00Z',
      },
    ],
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
  useAddListItem: () => ({
    mutate: mocks.add,
    isPending: false,
    error: null,
  }),
}));

describe('AddToListDialog', () => {
  beforeEach(() => vi.clearAllMocks());

  it('adds the selected media UUID to the chosen list', async () => {
    const user = userEvent.setup();
    const onAdded = vi.fn();
    render(
      <MemoryRouter>
        <AddToListDialog
          mediaId="media-1"
          title="Test Movie"
          onClose={vi.fn()}
          onAdded={onAdded}
        />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: /Favorites/ }));
    expect(mocks.add).toHaveBeenCalledWith(
      { listId: 'list-1', mediaId: 'media-1' },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );

    const options = mocks.add.mock.calls[0][1] as { onSuccess: () => void };
    options.onSuccess();
    expect(onAdded).toHaveBeenCalledWith('Favorites');
  });
});
