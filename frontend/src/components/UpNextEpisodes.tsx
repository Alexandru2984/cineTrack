import { Link } from 'react-router-dom';
import {
  AlertCircle,
  Bookmark,
  BookmarkCheck,
  Check,
  CheckCircle2,
  ChevronRight,
  Loader2,
  Play,
  RefreshCw,
} from 'lucide-react';
import {
  localDateKey,
  useMarkCalendarEpisodeWatched,
  useSetEpisodePlanned,
  useUpNextEpisodes,
} from '@/hooks/useCalendar';
import { getApiErrorMessage } from '@/lib/api';
import { formatRuntime, getPosterUrl } from '@/lib/utils';
import type { CalendarEpisode } from '@/types';

function episodeCode(item: CalendarEpisode): string {
  return `S${String(item.season_number).padStart(2, '0')}E${String(item.episode_number).padStart(2, '0')}`;
}

function airDateLabel(value: string): string {
  if (value === localDateKey()) return 'Today';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
  }).format(new Date(`${value}T12:00:00`));
}

export function UpNextEpisodes() {
  const upNext = useUpNextEpisodes();
  const setPlanned = useSetEpisodePlanned();
  const markWatched = useMarkCalendarEpisodeWatched();
  const items = upNext.data?.items ?? [];
  const actionError = setPlanned.error ?? markWatched.error;

  return (
    <section aria-labelledby="up-next-heading" aria-busy={upNext.isLoading}>
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 id="up-next-heading" className="flex items-center gap-2 text-xl font-bold">
          <Play
            className="h-5 w-5 text-emerald-600 dark:text-emerald-400"
            aria-hidden="true"
          />
          Up Next
        </h2>
        <Link
          to="/calendar"
          className="flex h-10 items-center gap-1 rounded-md px-2 text-sm font-medium text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--foreground))]"
        >
          Calendar
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </Link>
      </div>

      {actionError && (
        <div
          role="alert"
          className="mb-2 flex items-center gap-2 border-y border-[hsl(var(--destructive))]/40 py-3 text-sm text-[hsl(var(--destructive))]"
        >
          <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
          {getApiErrorMessage(actionError, 'Could not update this episode')}
        </div>
      )}

      {upNext.isLoading ? (
        <UpNextSkeleton />
      ) : upNext.isError ? (
        <div className="flex min-h-24 items-center justify-between gap-3 border-y border-[hsl(var(--border))] py-4">
          <div className="flex items-center gap-2 text-sm text-[hsl(var(--destructive))]">
            <AlertCircle className="h-5 w-5" aria-hidden="true" />
            Up Next unavailable
          </div>
          <button
            type="button"
            onClick={() => void upNext.refetch()}
            aria-label="Retry Up Next"
            title="Retry"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-[hsl(var(--border))] hover:bg-[hsl(var(--accent))]"
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      ) : items.length === 0 ? (
        <div className="flex min-h-24 items-center gap-3 border-y border-[hsl(var(--border))] py-4">
          <CheckCircle2
            className="h-6 w-6 text-emerald-600 dark:text-emerald-400"
            aria-hidden="true"
          />
          <div>
            <p className="text-sm font-semibold">You're caught up</p>
            <p className="text-xs text-[hsl(var(--muted-foreground))]">
              New episodes from your library will appear here.
            </p>
          </div>
        </div>
      ) : (
        <div className="divide-y divide-[hsl(var(--border))] border-y border-[hsl(var(--border))]">
          {items.map((item) => (
            <UpNextRow
              key={item.episode_id}
              item={item}
              planPending={
                setPlanned.isPending && setPlanned.variables?.episodeId === item.episode_id
              }
              watchedPending={
                markWatched.isPending && markWatched.variables === item.episode_id
              }
              onPlan={() =>
                setPlanned.mutate({
                  episodeId: item.episode_id,
                  planned: !item.is_planned,
                })
              }
              onWatched={() => markWatched.mutate(item.episode_id)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function UpNextRow({
  item,
  planPending,
  watchedPending,
  onPlan,
  onWatched,
}: {
  item: CalendarEpisode;
  planPending: boolean;
  watchedPending: boolean;
  onPlan: () => void;
  onWatched: () => void;
}) {
  const episodeName = item.episode_name || `Episode ${item.episode_number}`;

  return (
    <article className="grid min-h-20 grid-cols-[5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2 py-3 sm:grid-cols-[6rem_minmax(0,1fr)_auto]">
      <Link
        to={`/episodes/${item.episode_id}`}
        aria-label={`Open ${episodeName}`}
        className="row-span-2 flex h-14 w-20 items-center justify-center overflow-hidden rounded bg-[hsl(var(--muted))] sm:row-span-1 sm:h-16 sm:w-24"
      >
        <img
          src={getPosterUrl(
            item.still_path ?? item.poster_path,
            item.still_path ? 'w300' : 'w92',
          )}
          alt=""
          className={`h-full w-full ${item.still_path ? 'object-cover' : 'object-contain'}`}
          loading="lazy"
        />
      </Link>
      <div className="min-w-0 flex-1">
        <Link
          to={`/media/${item.tmdb_id}?type=tv`}
          className="block truncate text-sm font-semibold hover:text-emerald-600 dark:hover:text-emerald-400"
        >
          {item.title}
        </Link>
        <Link
          to={`/episodes/${item.episode_id}`}
          className="mt-0.5 block truncate text-xs hover:text-emerald-600 dark:hover:text-emerald-400"
        >
          <span className="mr-1.5 font-mono text-[hsl(var(--muted-foreground))]">
            {episodeCode(item)}
          </span>
          {episodeName}
        </Link>
        <p className="mt-1 flex gap-2 text-[11px] text-[hsl(var(--muted-foreground))]">
          <span>{airDateLabel(item.air_date)}</span>
          {item.runtime_minutes != null && <span>{formatRuntime(item.runtime_minutes)}</span>}
        </p>
      </div>
      <div className="col-start-2 row-start-2 flex items-center gap-1 sm:col-start-3 sm:row-start-1">
        <button
          type="button"
          aria-label={
            item.is_planned
              ? `Remove ${episodeName} from Watch next`
              : `Add ${episodeName} to Watch next`
          }
          title={item.is_planned ? 'Remove from Watch next' : 'Add to Watch next'}
          disabled={planPending || watchedPending}
          onClick={onPlan}
          className={`flex h-10 w-10 items-center justify-center rounded-md border transition-colors disabled:opacity-50 ${
            item.is_planned
              ? 'border-amber-500 bg-amber-500/10 text-amber-600 dark:text-amber-400'
              : 'border-[hsl(var(--border))] hover:border-amber-500 hover:text-amber-600'
          }`}
        >
          {planPending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : item.is_planned ? (
            <BookmarkCheck className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Bookmark className="h-4 w-4" aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          aria-label={`Mark ${episodeName} watched`}
          title="Mark watched"
          disabled={planPending || watchedPending}
          onClick={onWatched}
          className="flex h-10 w-10 items-center justify-center rounded-md border border-[hsl(var(--border))] transition-colors hover:border-emerald-500 hover:bg-emerald-500/10 hover:text-emerald-600 disabled:opacity-50 dark:hover:text-emerald-400"
        >
          {watchedPending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Check className="h-4 w-4" aria-hidden="true" />
          )}
        </button>
      </div>
    </article>
  );
}

function UpNextSkeleton() {
  return (
    <div
      role="status"
      className="animate-pulse divide-y divide-[hsl(var(--border))] border-y border-[hsl(var(--border))]"
    >
      <span className="sr-only">Loading Up Next</span>
      {Array.from({ length: 3 }, (_, index) => (
        <div key={index} className="flex h-20 items-center gap-3 py-3" aria-hidden="true">
          <div className="h-14 w-20 rounded bg-[hsl(var(--muted))]" />
          <div className="flex-1 space-y-2">
            <div className="h-3.5 w-28 rounded bg-[hsl(var(--muted))]" />
            <div className="h-3 w-36 max-w-full rounded bg-[hsl(var(--muted))]" />
          </div>
          <div className="h-10 w-[5.25rem] rounded bg-[hsl(var(--muted))]" />
        </div>
      ))}
    </div>
  );
}
