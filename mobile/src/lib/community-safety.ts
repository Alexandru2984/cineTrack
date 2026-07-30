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

export interface ReportInput {
  target_type: ReportTargetType;
  target_id: string;
  reason: ReportReason;
  details?: string;
}

export function reportInputFromDraft(
  targetType: ReportTargetType,
  targetId: string,
  reason: ReportReason,
  details: string,
): ReportInput {
  const normalizedDetails = details.trim();
  return {
    target_type: targetType,
    target_id: targetId,
    reason,
    ...(normalizedDetails ? { details: normalizedDetails } : {}),
  };
}
