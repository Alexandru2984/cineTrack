import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ReportDialog } from '@/components/ReportDialog';

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
}));

vi.mock('@/hooks/useCommunitySafety', () => ({
  useReportContent: () => ({
    mutate: mocks.mutate,
    isPending: false,
    isSuccess: false,
    error: null,
  }),
}));

describe('ReportDialog', () => {
  beforeEach(() => vi.clearAllMocks());

  it('submits only the server-supported target, reason, and trimmed context', async () => {
    const user = userEvent.setup();
    render(
      <ReportDialog
        targetType="list"
        targetId="00000000-0000-0000-0000-000000000123"
        targetLabel="Suspicious list"
        onClose={vi.fn()}
      />,
    );

    await user.selectOptions(screen.getByLabelText('Reason'), 'spam');
    await user.type(
      screen.getByLabelText('Details (optional)'),
      '  Repetitive scam links  ',
    );
    await user.click(screen.getByRole('button', { name: 'Submit report' }));

    expect(mocks.mutate).toHaveBeenCalledWith({
      target_type: 'list',
      target_id: '00000000-0000-0000-0000-000000000123',
      reason: 'spam',
      details: 'Repetitive scam links',
    });
  });
});
