import {
  REPORT_REASONS,
  reportInputFromDraft,
} from '@/lib/community-safety';

describe('community safety helpers', () => {
  it('keeps the fixed server-supported report reasons unique', () => {
    expect(REPORT_REASONS).toHaveLength(10);
    expect(new Set(REPORT_REASONS).size).toBe(REPORT_REASONS.length);
  });

  it('trims useful report details', () => {
    expect(reportInputFromDraft('user', 'user-id', 'harassment', '  Context  ')).toEqual({
      target_type: 'user',
      target_id: 'user-id',
      reason: 'harassment',
      details: 'Context',
    });
  });

  it('omits blank optional report details', () => {
    expect(reportInputFromDraft('list', 'list-id', 'spam', ' \n ')).toEqual({
      target_type: 'list',
      target_id: 'list-id',
      reason: 'spam',
    });
  });
});
