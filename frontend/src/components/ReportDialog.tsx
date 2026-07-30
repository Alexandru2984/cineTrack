import { CheckCircle2, Flag, Loader2, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';

import { useReportContent } from '@/hooks/useCommunitySafety';
import { useT } from '@/hooks/useT';
import { getApiErrorMessage } from '@/lib/api';
import {
  REPORT_REASONS,
  type ReportReason,
  type ReportTargetType,
} from '@/lib/community-safety';

export function ReportDialog({
  targetType,
  targetId,
  targetLabel,
  onClose,
}: {
  targetType: ReportTargetType;
  targetId: string;
  targetLabel: string;
  onClose: () => void;
}) {
  const t = useT();
  const titleId = useId();
  const detailsId = useId();
  const [reason, setReason] = useState<ReportReason>('harassment');
  const [details, setDetails] = useState('');
  const report = useReportContent();
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  const pendingRef = useRef(report.isPending);

  useEffect(() => {
    closeRef.current = onClose;
    pendingRef.current = report.isPending;
  }, [onClose, report.isPending]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.style.overflow = 'hidden';
    const focusableSelector =
      'a[href], button:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusableElements = () =>
      Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? []);
    focusableElements()[0]?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !pendingRef.current) {
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const elements = focusableElements();
      if (elements.length === 0) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (!dialogRef.current?.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
      previouslyFocused?.focus();
    };
  }, []);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedDetails = details.trim();
    report.mutate({
      target_type: targetType,
      target_id: targetId,
      reason,
      ...(normalizedDetails ? { details: normalizedDetails } : {}),
    });
  };

  return (
    <div
      className="fixed inset-0 z-[80] flex items-end justify-center bg-black/65 p-0 sm:items-center sm:p-4"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target && !report.isPending) onClose();
      }}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="max-h-[calc(100dvh-env(safe-area-inset-top))] w-full overflow-y-auto rounded-t-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] shadow-2xl sm:max-w-lg sm:rounded-xl sm:p-6"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <span className="rounded-full bg-[hsl(var(--destructive))]/10 p-2 text-[hsl(var(--destructive))]">
              <Flag className="h-5 w-5" aria-hidden="true" />
            </span>
            <div>
              <h2 id={titleId} className="text-xl font-semibold">
                {t('safety.reportTitle')}
              </h2>
              <p className="mt-1 break-words text-sm text-[hsl(var(--muted-foreground))]">
                {t('safety.reportTarget', { target: targetLabel })}
              </p>
            </div>
          </div>
          <button
            type="button"
            aria-label={t('safety.closeReportAria')}
            disabled={report.isPending}
            onClick={onClose}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-[hsl(var(--border))] disabled:opacity-50"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        {report.isSuccess ? (
          <div className="mt-6 space-y-5 text-center">
            <CheckCircle2
              className="mx-auto h-10 w-10 text-emerald-600 dark:text-emerald-400"
              aria-hidden="true"
            />
            <div>
              <p className="font-semibold">{t('safety.reportSent')}</p>
              <p className="mt-2 text-sm text-[hsl(var(--muted-foreground))]">
                {t('safety.reportSentHint')}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="h-11 w-full rounded-md bg-[hsl(var(--primary))] px-4 text-sm font-semibold text-[hsl(var(--primary-foreground))]"
            >
              {t('common.done')}
            </button>
          </div>
        ) : (
          <form className="mt-6 space-y-5" onSubmit={submit}>
            <label className="block space-y-2">
              <span className="text-sm font-medium">{t('safety.reason')}</span>
              <select
                value={reason}
                onChange={(event) => setReason(event.target.value as ReportReason)}
                className="h-11 w-full rounded-md border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-3 text-sm outline-none focus:border-[hsl(var(--primary))]"
              >
                {REPORT_REASONS.map((value) => (
                  <option key={value} value={value}>
                    {t(`safety.reason_${value}`)}
                  </option>
                ))}
              </select>
            </label>

            <div className="space-y-2">
              <label htmlFor={detailsId} className="block text-sm font-medium">
                {t('safety.detailsOptional')}
              </label>
              <textarea
                id={detailsId}
                maxLength={1000}
                value={details}
                onChange={(event) => setDetails(event.target.value)}
                className="min-h-28 w-full resize-y rounded-md border border-[hsl(var(--input))] bg-transparent px-3 py-2 text-sm outline-none focus:border-[hsl(var(--primary))]"
                placeholder={t('safety.detailsPlaceholder')}
              />
              <span className="block text-right text-xs text-[hsl(var(--muted-foreground))]">
                {details.length}/1000
              </span>
            </div>

            <p className="text-xs leading-5 text-[hsl(var(--muted-foreground))]">
              {t('safety.reportPrivacyHint')}
            </p>

            {report.error ? (
              <p className="text-sm text-[hsl(var(--destructive))]" role="alert">
                {getApiErrorMessage(report.error, t('safety.reportError'))}
              </p>
            ) : null}

            <div className="flex gap-3">
              <button
                type="button"
                disabled={report.isPending}
                onClick={onClose}
                className="h-11 flex-1 rounded-md border border-[hsl(var(--border))] px-4 text-sm font-medium disabled:opacity-50"
              >
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                disabled={report.isPending}
                className="flex h-11 flex-1 items-center justify-center gap-2 rounded-md bg-[hsl(var(--destructive))] px-4 text-sm font-semibold text-[hsl(var(--destructive-foreground))] disabled:opacity-50"
              >
                {report.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : null}
                {t('safety.submitReport')}
              </button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
