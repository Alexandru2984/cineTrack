import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ModerationPage from '@/pages/Moderation';

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
}));

vi.mock('@/hooks/useCommunitySafety', () => ({
  useModerationReports: () => ({
    data: {
      items: [
        {
          id: 'report-1',
          reporter_id: 'reporter-1',
          reporter_username: 'reporter',
          subject_user_id: 'subject-1',
          subject_username: 'subject',
          target_type: 'message',
          target_id: 'message-1',
          reason: 'child_safety',
          details: 'Urgent context',
          content_snapshot: {
            sender_id: 'subject-1',
            body: '<script>alert(1)</script>',
          },
          status: 'open',
          moderated_by: null,
          moderator_username: null,
          moderator_note: null,
          resolved_at: null,
          created_at: '2026-07-30T12:00:00Z',
          updated_at: '2026-07-30T12:00:00Z',
        },
      ],
      counts: { open: 1, reviewing: 0, actioned: 0, dismissed: 0 },
      page: 1,
      has_more: false,
    },
    isLoading: false,
    isError: false,
    isFetching: false,
    error: null,
    refetch: vi.fn(),
  }),
  useUpdateModerationReport: () => ({
    mutate: mocks.update,
    isPending: false,
    error: null,
  }),
}));

describe('Moderation page', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows priority evidence as text and records a justified transition', async () => {
    const user = userEvent.setup();
    render(<ModerationPage />);

    expect(screen.getByText('Priority review')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Message from @subject' })).toBeVisible();
    await user.click(screen.getByText('Server evidence snapshot'));
    expect(screen.getByText('<script>alert(1)</script>')).toBeVisible();
    expect(document.querySelector('script')).toBeNull();

    await user.type(
      screen.getByRole('textbox', { name: 'Decision note' }),
      'Claiming urgent review',
    );
    await user.click(screen.getByRole('button', { name: 'Save decision' }));

    expect(mocks.update).toHaveBeenCalledWith(
      {
        id: 'report-1',
        status: 'reviewing',
        note: 'Claiming urgent review',
      },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });
});
