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
export type ReportTargetType = 'user' | 'list' | 'message';

export interface ReportInput {
  target_type: ReportTargetType;
  target_id: string;
  reason: ReportReason;
  details?: string;
  /** Only for an encrypted message, and required there: the server cannot read
   *  it, so the reporter supplies the text and the key that opens the sender's
   *  commitment to it. Without both, a report against an encrypted message
   *  would be indistinguishable from an accusation somebody typed. */
  revealed_plaintext?: string;
  franking_key?: string;
}

export function reportInputFromDraft(
  targetType: ReportTargetType,
  targetId: string,
  reason: ReportReason,
  details: string,
  /** What the reporter decrypted, for a message the server cannot read. The
   *  franking key opens the sender's commitment, which is what turns a report
   *  into evidence rather than an assertion. */
  evidence?: { revealedPlaintext: string; frankingKey: string },
): ReportInput {
  const normalizedDetails = details.trim();
  return {
    target_type: targetType,
    target_id: targetId,
    reason,
    ...(normalizedDetails ? { details: normalizedDetails } : {}),
    ...(evidence
      ? {
          revealed_plaintext: evidence.revealedPlaintext,
          franking_key: evidence.frankingKey,
        }
      : {}),
  };
}
