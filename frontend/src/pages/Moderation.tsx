import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Loader2,
  ShieldAlert,
} from 'lucide-react';
import { useState } from 'react';

import {
  type ModerationQueueFilter,
  useModerationReports,
  useUpdateModerationReport,
} from '@/hooks/useCommunitySafety';
import { usePageTitle } from '@/hooks/usePageTitle';
import { useT } from '@/hooks/useT';
import { getApiErrorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';
import type {
  ModerationReport,
  ModerationReportStatus,
  ModerationStatusCounts,
} from '@/types';

const FILTERS: readonly ModerationQueueFilter[] = [
  'active',
  'open',
  'reviewing',
  'actioned',
  'dismissed',
  'all',
];

function filterCount(
  filter: ModerationQueueFilter,
  counts: ModerationStatusCounts | undefined,
): number | null {
  if (!counts) return null;
  if (filter === 'active') return counts.open + counts.reviewing;
  if (filter === 'all') {
    return counts.open + counts.reviewing + counts.actioned + counts.dismissed;
  }
  return counts[filter];
}

function snapshotValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function nextStatuses(status: ModerationReportStatus): ModerationReportStatus[] {
  if (status === 'open') return ['reviewing', 'actioned', 'dismissed'];
  if (status === 'reviewing') return ['open', 'actioned', 'dismissed'];
  return [];
}

function ReportCard({ report }: { report: ModerationReport }) {
  const t = useT();
  const update = useUpdateModerationReport();
  const choices = nextStatuses(report.status);
  const [nextStatus, setNextStatus] = useState<ModerationReportStatus>(
    choices[0] ?? report.status,
  );
  const [note, setNote] = useState('');
  const urgent = report.reason === 'child_safety' || report.reason === 'threatening';

  return (
    <article
      className={`rounded-lg border p-4 sm:p-6 ${
        urgent
          ? 'border-amber-500/70 bg-amber-500/5'
          : 'border-[hsl(var(--border))]'
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded-full px-2 py-1 text-xs font-semibold ${
                urgent
                  ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                  : 'bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]'
              }`}
            >
              {t(`safety.reason_${report.reason}`)}
            </span>
            <span className="rounded-full bg-[hsl(var(--muted))] px-2 py-1 text-xs">
              {t(`moderation.status_${report.status}`)}
            </span>
          </div>
          <h2 className="mt-3 break-words text-lg font-semibold">
            {report.target_type === 'user'
              ? `@${report.subject_username ?? t('moderation.deletedAccount')}`
              : snapshotValue(report.content_snapshot.name)}
          </h2>
          <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">
            {t('moderation.reportMeta', {
              reporter: report.reporter_username
                ? `@${report.reporter_username}`
                : t('moderation.deletedAccount'),
              date: formatDateTime(report.created_at),
            })}
          </p>
        </div>
        {urgent ? (
          <span className="flex items-center gap-1 text-xs font-semibold text-amber-700 dark:text-amber-300">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            {t('moderation.priority')}
          </span>
        ) : null}
      </div>

      {report.details ? (
        <section className="mt-5">
          <h3 className="text-sm font-semibold">{t('moderation.reporterDetails')}</h3>
          <p className="mt-2 whitespace-pre-wrap break-words rounded-md bg-[hsl(var(--muted))] p-3 text-sm">
            {report.details}
          </p>
        </section>
      ) : null}

      <details className="mt-5 rounded-md border border-[hsl(var(--border))]">
        <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
          {t('moderation.evidenceSnapshot')}
        </summary>
        <dl className="grid gap-3 border-t border-[hsl(var(--border))] p-3 text-sm sm:grid-cols-2">
          {Object.entries(report.content_snapshot).map(([key, value]) => (
            <div key={key} className="min-w-0">
              <dt className="text-xs font-semibold uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
                {key.replaceAll('_', ' ')}
              </dt>
              <dd className="mt-1 whitespace-pre-wrap break-all">{snapshotValue(value)}</dd>
            </div>
          ))}
        </dl>
      </details>

      {report.moderator_note ? (
        <div className="mt-5 rounded-md border border-[hsl(var(--border))] p-3 text-sm">
          <p className="font-semibold">
            {t('moderation.lastDecision', {
              moderator: report.moderator_username
                ? `@${report.moderator_username}`
                : t('moderation.deletedAccount'),
            })}
          </p>
          <p className="mt-2 whitespace-pre-wrap break-words text-[hsl(var(--muted-foreground))]">
            {report.moderator_note}
          </p>
        </div>
      ) : null}

      {choices.length > 0 ? (
        <div className="mt-5 grid gap-3 border-t border-[hsl(var(--border))] pt-5 sm:grid-cols-[12rem_minmax(0,1fr)]">
          <label className="space-y-2 text-sm font-medium">
            <span>{t('moderation.nextStatus')}</span>
            <select
              value={nextStatus}
              onChange={(event) =>
                setNextStatus(event.target.value as ModerationReportStatus)
              }
              disabled={update.isPending}
              className="h-11 w-full rounded-md border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-3"
            >
              {choices.map((status) => (
                <option key={status} value={status}>
                  {t(`moderation.status_${status}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-2 text-sm font-medium">
            <span>{t('moderation.decisionNote')}</span>
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={2000}
              disabled={update.isPending}
              placeholder={t('moderation.decisionPlaceholder')}
              className="min-h-24 w-full rounded-md border border-[hsl(var(--input))] bg-transparent px-3 py-2"
            />
          </label>
          <div className="sm:col-start-2">
            <button
              type="button"
              disabled={update.isPending || note.trim().length < 3}
              onClick={() =>
                update.mutate(
                  {
                    id: report.id,
                    status: nextStatus,
                    note: note.trim(),
                  },
                  { onSuccess: () => setNote('') },
                )
              }
              className="flex h-11 w-full items-center justify-center gap-2 rounded-md bg-[hsl(var(--primary))] px-4 text-sm font-semibold text-[hsl(var(--primary-foreground))] disabled:opacity-50 sm:w-auto"
            >
              {update.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
              )}
              {t('moderation.saveDecision')}
            </button>
            {update.error ? (
              <p className="mt-2 text-sm text-[hsl(var(--destructive))]" role="alert">
                {getApiErrorMessage(update.error, t('moderation.updateError'))}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </article>
  );
}

export default function ModerationPage() {
  const t = useT();
  usePageTitle(t('moderation.title'));
  const [filter, setFilter] = useState<ModerationQueueFilter>('active');
  const [page, setPage] = useState(1);
  const queue = useModerationReports(filter, page);

  const chooseFilter = (value: ModerationQueueFilter) => {
    setFilter(value);
    setPage(1);
  };

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-8">
      <header className="flex items-start gap-3">
        <span className="rounded-full bg-[hsl(var(--primary))]/10 p-2 text-[hsl(var(--primary))]">
          <ShieldAlert className="h-6 w-6" aria-hidden="true" />
        </span>
        <div>
          <h1 className="text-2xl font-bold">{t('moderation.title')}</h1>
          <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
            {t('moderation.subtitle')}
          </p>
        </div>
      </header>

      <nav
        aria-label={t('moderation.filtersAria')}
        className="mt-6 flex gap-2 overflow-x-auto pb-2"
      >
        {FILTERS.map((value) => {
          const count = filterCount(value, queue.data?.counts);
          return (
            <button
              key={value}
              type="button"
              aria-pressed={filter === value}
              onClick={() => chooseFilter(value)}
              className={`h-10 shrink-0 rounded-full border px-3 text-sm font-medium ${
                filter === value
                  ? 'border-[hsl(var(--primary))] bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]'
                  : 'border-[hsl(var(--border))]'
              }`}
            >
              {t(`moderation.filter_${value}`)}
              {count !== null ? ` · ${count}` : ''}
            </button>
          );
        })}
      </nav>

      <div className="mt-5 space-y-4" aria-live="polite">
        {queue.isLoading ? (
          <div className="flex min-h-40 items-center justify-center gap-2 text-sm text-[hsl(var(--muted-foreground))]">
            <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
            {t('moderation.loading')}
          </div>
        ) : queue.isError ? (
          <div className="rounded-lg border border-[hsl(var(--destructive))]/40 p-5">
            <p className="text-sm text-[hsl(var(--destructive))]" role="alert">
              {getApiErrorMessage(queue.error, t('moderation.loadError'))}
            </p>
            <button
              type="button"
              onClick={() => void queue.refetch()}
              className="mt-3 h-10 rounded-md border border-[hsl(var(--border))] px-3 text-sm font-medium"
            >
              {t('common.tryAgain')}
            </button>
          </div>
        ) : queue.data?.items.length === 0 ? (
          <div className="rounded-lg border border-[hsl(var(--border))] p-8 text-center">
            <Clock3
              className="mx-auto h-8 w-8 text-[hsl(var(--muted-foreground))]"
              aria-hidden="true"
            />
            <p className="mt-3 font-medium">{t('moderation.empty')}</p>
          </div>
        ) : (
          queue.data?.items.map((report) => (
            <ReportCard key={report.id} report={report} />
          ))
        )}
      </div>

      {queue.data && (page > 1 || queue.data.has_more) ? (
        <div className="mt-6 flex items-center justify-between gap-3">
          <button
            type="button"
            disabled={page === 1 || queue.isFetching}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
            className="flex h-10 items-center gap-1 rounded-md border border-[hsl(var(--border))] px-3 text-sm font-medium disabled:opacity-50"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            {t('common.previous')}
          </button>
          <span className="text-sm text-[hsl(var(--muted-foreground))]">
            {t('moderation.page', { page })}
          </span>
          <button
            type="button"
            disabled={!queue.data.has_more || queue.isFetching}
            onClick={() => setPage((current) => current + 1)}
            className="flex h-10 items-center gap-1 rounded-md border border-[hsl(var(--border))] px-3 text-sm font-medium disabled:opacity-50"
          >
            {t('common.next')}
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </div>
  );
}
