import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CalendarFeedCard } from '@/components/CalendarFeedCard';

type MutateOptions = { onSuccess?: (data: { feed_url: string }) => void };

const mocks = vi.hoisted(() => ({
  status: { data: { enabled: false } } as { data?: { enabled: boolean } },
  enableMutate: vi.fn(),
  disableMutate: vi.fn(),
}));

vi.mock('@/hooks/useCalendar', () => ({
  useCalendarFeedStatus: () => mocks.status,
  useEnableCalendarFeed: () => ({ mutate: mocks.enableMutate, isPending: false, error: null }),
  useDisableCalendarFeed: () => ({ mutate: mocks.disableMutate, isPending: false, error: null }),
}));

describe('CalendarFeedCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.status = { data: { enabled: false } };
  });

  it('offers to generate a feed when none is active', () => {
    render(<CalendarFeedCard />);
    expect(screen.getByRole('button', { name: 'Generate feed URL' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Disable' })).not.toBeInTheDocument();
  });

  it('shows regenerate and disable when the feed is active', () => {
    mocks.status = { data: { enabled: true } };
    render(<CalendarFeedCard />);
    expect(screen.getByRole('button', { name: 'Regenerate URL' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Disable' })).toBeVisible();
  });

  it('reveals the generated URL once for copying', async () => {
    const user = userEvent.setup();
    mocks.enableMutate.mockImplementation((_input: undefined, options?: MutateOptions) => {
      options?.onSuccess?.({ feed_url: 'https://vazute.micutu.com/api/calendar/feed/abc.ics' });
    });

    render(<CalendarFeedCard />);
    await user.click(screen.getByRole('button', { name: 'Generate feed URL' }));

    expect(screen.getByLabelText('Calendar feed URL')).toHaveValue(
      'https://vazute.micutu.com/api/calendar/feed/abc.ics',
    );
    expect(screen.getByText(/won.t be shown again/i)).toBeVisible();
  });
});
