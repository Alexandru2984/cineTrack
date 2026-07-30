export const REPORT_REASONS = [
  'harassment',
  'hate',
  'threatening',
  'sexual',
  'child_safety',
  'impersonation',
  'spam',
  'privacy',
  'copyright',
  'other',
] as const;

export type ReportReason = (typeof REPORT_REASONS)[number];
export type ReportTargetType = 'user' | 'list';
