import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { NotificationList } from '@/components/NotificationList';
import type { SocialNotification } from '@/types';

const requestNotification: SocialNotification = {
  id: 'notification-1',
  kind: 'follow_request',
  actor_id: 'user-1',
  actor_username: 'private_requester',
  actor_avatar_url: null,
  read_at: null,
  created_at: '2026-07-13T12:00:00Z',
};

const acceptedNotification: SocialNotification = {
  id: 'notification-2',
  kind: 'follow_accepted',
  actor_id: 'user-2',
  actor_username: 'user with spaces',
  actor_avatar_url: 'https://example.com/avatar.jpg',
  read_at: '2026-07-13T12:05:00Z',
  created_at: '2026-07-13T12:01:00Z',
};

describe('NotificationList', () => {
  it('links each social event to its action and only marks unread rows', () => {
    const onRead = vi.fn();
    render(
      <MemoryRouter>
        <NotificationList items={[requestNotification, acceptedNotification]} onRead={onRead} />
      </MemoryRouter>,
    );

    const requestLink = screen.getByRole('link', {
      name: /private_requester requested to follow you/i,
    });
    expect(requestLink).toHaveAttribute('href', '/settings#follow-requests');
    fireEvent.click(requestLink);
    expect(onRead).toHaveBeenCalledWith('notification-1');

    const acceptedLink = screen.getByRole('link', {
      name: /user with spaces accepted your follow request/i,
    });
    expect(acceptedLink).toHaveAttribute('href', '/profile/user%20with%20spaces');
    fireEvent.click(acceptedLink);
    expect(onRead).toHaveBeenCalledTimes(1);
    expect(document.querySelector('img')).toHaveAttribute(
      'src',
      acceptedNotification.actor_avatar_url,
    );
  });

  it('renders explicit empty and error states', () => {
    const { rerender } = render(
      <MemoryRouter>
        <NotificationList items={[]} />
      </MemoryRouter>,
    );
    expect(screen.getByText('No notifications yet')).toBeInTheDocument();

    rerender(
      <MemoryRouter>
        <NotificationList isError />
      </MemoryRouter>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Notifications could not be loaded');
  });
});
