import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { ActivityList } from '@/components/ActivityList';
import type { ActivityItem } from '@/types';

const episodeActivity: ActivityItem = {
  id: 'activity-1',
  user_id: 'user-1',
  username: 'followed_user',
  avatar_url: null,
  action: 'watched',
  tmdb_id: 502,
  media_title: 'Followed Show',
  media_type: 'tv',
  poster_path: null,
  episode_name: 'The Reveal',
  season_number: 2,
  episode_number: 3,
  timestamp: '2026-07-12T12:00:00Z',
};

describe('ActivityList', () => {
  it('links social and episode activity to the relevant pages', () => {
    render(
      <MemoryRouter>
        <ActivityList items={[episodeActivity]} />
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: 'followed_user' })).toHaveAttribute(
      'href',
      '/profile/followed_user',
    );
    expect(screen.getByRole('link', { name: 'Open Followed Show' })).toHaveAttribute(
      'href',
      '/media/502?type=tv',
    );
    expect(screen.getByText('S2 E3 · The Reveal')).toBeInTheDocument();
    expect(screen.getByText('TV show')).toBeInTheDocument();
    expect(screen.getByText('watched')).toBeInTheDocument();
    expect(screen.getByText(/Followed Show/)).toBeInTheDocument();
    expect(document.querySelector('time')).toHaveAttribute(
      'datetime',
      episodeActivity.timestamp,
    );
  });

  it('renders explicit empty and error states', () => {
    const { rerender } = render(
      <MemoryRouter>
        <ActivityList items={[]} />
      </MemoryRouter>,
    );
    expect(screen.getByText('No recent activity')).toBeInTheDocument();

    rerender(
      <MemoryRouter>
        <ActivityList isError />
      </MemoryRouter>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Activity could not be loaded');
  });
});
