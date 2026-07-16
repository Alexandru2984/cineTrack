import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertCircle,
  Bookmark,
  BookmarkCheck,
  CalendarDays,
  Check,
  ChevronDown,
  Clock3,
  Film,
  Loader2,
  RefreshCw,
  Tv,
} from 'lucide-react';
import {
  localDateKey,
  useCalendarPreferences,
  useCalendarSummary,
  useMarkCalendarEpisodeWatched,
  useNewEpisodes,
  useSetEpisodePlanned,
  useUpcomingReleases,
  useUpdateCalendarPreferences,
} from '@/hooks/useCalendar';
import { getApiErrorMessage } from '@/lib/api';
import { formatRuntime, getPosterUrl } from '@/lib/utils';
import type { CalendarEpisode, UpcomingCalendarItem } from '@/types';

type CalendarView = 'new' | 'upcoming';
type UpcomingFilter = 'all' | 'tv' | 'movie';

const COUNTRY_OPTIONS = [
  ['RO', 'Romania'],
  ['US', 'United States'],
  ['GB', 'United Kingdom'],
  ['DE', 'Germany'],
  ['FR', 'France'],
  ['IT', 'Italy'],
  ['ES', 'Spain'],
  ['NL', 'Netherlands'],
  ['SE', 'Sweden'],
  ['PL', 'Poland'],
  ['CA', 'Canada'],
  ['AU', 'Australia'],
  ['JP', 'Japan'],
  ['KR', 'South Korea'],
] as const;

const RELEASE_TYPE_LABELS: Record<number, string> = {
  1: 'Premiere',
  2: 'Limited cinema',
  3: 'Cinema',
  4: 'Digital',
  5: 'Physical',
  6: 'TV',
};

function parseCalendarDate(value: string): Date {
  return new Date(`${value}T12:00:00`);
}

function formatCalendarDate(value: string, includeWeekday = true): string {
  return new Intl.DateTimeFormat('en-US', {
    ...(includeWeekday && { weekday: 'long' }),
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(parseCalendarDate(value));
}

function uniqueById<T>(items: T[], id: (item: T) => string): T[] {
  return Array.from(new Map(items.map((item) => [id(item), item])).values());
}

function episodeCode(season: number, episode: number): string {
  return `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
}

function newEpisodeBucket(airDate: string, today: string): string {
  if (airDate === today) return 'Today';
  const daysAgo = Math.round(
    (parseCalendarDate(today).getTime() - parseCalendarDate(airDate).getTime()) / 86_400_000,
  );
  return daysAgo <= 7 ? 'This week' : 'Earlier';
}

function actionError(error: unknown): string | null {
  return error ? getApiErrorMessage(error, 'Could not update this episode') : null;
}

export default function CalendarPage() {
  const [view, setView] = useState<CalendarView>('new');
  const [upcomingFilter, setUpcomingFilter] = useState<UpcomingFilter>('all');
  const [includeSpecials, setIncludeSpecials] = useState(false);
  const summary = useCalendarSummary();
  const newEpisodes = useNewEpisodes(includeSpecials, view === 'new');
  const upcoming = useUpcomingReleases(
    upcomingFilter,
    includeSpecials,
    view === 'upcoming',
  );
  const preferences = useCalendarPreferences();
  const updatePreferences = useUpdateCalendarPreferences();
  const setPlanned = useSetEpisodePlanned();
  const markWatched = useMarkCalendarEpisodeWatched();

  const newItems = useMemo(
    () =>
      uniqueById(
        newEpisodes.data?.pages.flatMap((page) => page.items) ?? [],
        (item) => item.episode_id,
      ),
    [newEpisodes.data],
  );
  const upcomingItems = useMemo(
    () =>
      uniqueById(
        upcoming.data?.pages.flatMap((page) => page.items) ?? [],
        (item) => `${item.item_kind}:${item.item_id}:${item.release_type ?? 'default'}`,
      ),
    [upcoming.data],
  );
  const activeQuery = view === 'new' ? newEpisodes : upcoming;
  const activeItems = view === 'new' ? newItems : upcomingItems;
  const fetchNextPage = activeQuery.fetchNextPage;
  const hasNextPage = activeQuery.hasNextPage;
  const isFetchingNextPage = activeQuery.isFetchingNextPage;
  const mutationError = actionError(setPlanned.error) ?? actionError(markWatched.error);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const countryCode = updatePreferences.variables
    ?? preferences.data?.country_code
    ?? upcoming.data?.pages[0]?.country_code
    ?? 'RO';

  useEffect(() => {
    const target = loadMoreRef.current;
    if (
      !target
      || !hasNextPage
      || isFetchingNextPage
      || typeof IntersectionObserver === 'undefined'
    ) {
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          void fetchNextPage();
        }
      },
      { rootMargin: '320px 0px' },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    view,
  ]);

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
      <header className="flex flex-wrap items-end justify-between gap-3 border-b border-[hsl(var(--border))] pb-5">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold sm:text-3xl">
            <CalendarDays className="h-6 w-6 text-cyan-600 dark:text-cyan-400" aria-hidden="true" />
            Calendar
          </h1>
          {summary.data?.last_synced_at && (
            <p className="mt-1 flex items-center gap-1.5 text-xs text-[hsl(var(--muted-foreground))]">
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              Updated {new Date(summary.data.last_synced_at).toLocaleString()}
            </p>
          )}
        </div>

        <label className="flex items-center gap-2 text-sm">
          <span className="text-[hsl(var(--muted-foreground))]">Region</span>
          <select
            aria-label="Release region"
            value={countryCode}
            disabled={preferences.isLoading || updatePreferences.isPending}
            onChange={(event) => updatePreferences.mutate(event.target.value)}
            className="h-9 rounded-md border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-2 text-sm disabled:opacity-50"
          >
            {!COUNTRY_OPTIONS.some(([code]) => code === countryCode) && (
              <option value={countryCode}>{countryCode}</option>
            )}
            {COUNTRY_OPTIONS.map(([code, name]) => (
              <option key={code} value={code}>{name}</option>
            ))}
          </select>
        </label>
      </header>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <div
          className="inline-flex h-10 overflow-hidden rounded-md border border-[hsl(var(--border))]"
          role="tablist"
          aria-label="Calendar view"
        >
          <button
            type="button"
            role="tab"
            aria-selected={view === 'new'}
            onClick={() => setView('new')}
            className={`flex min-w-36 items-center justify-center gap-2 px-3 text-sm font-medium transition-colors ${
              view === 'new'
                ? 'bg-[hsl(var(--foreground))] text-[hsl(var(--background))]'
                : 'hover:bg-[hsl(var(--accent))]'
            }`}
          >
            New episodes
            {(summary.data?.new_count ?? 0) > 0 && (
              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-cyan-600 px-1 text-[11px] font-semibold text-white">
                {summary.data!.new_count > 99 ? '99+' : summary.data!.new_count}
              </span>
            )}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'upcoming'}
            onClick={() => setView('upcoming')}
            className={`min-w-28 border-l border-[hsl(var(--border))] px-3 text-sm font-medium transition-colors ${
              view === 'upcoming'
                ? 'bg-[hsl(var(--foreground))] text-[hsl(var(--background))]'
                : 'hover:bg-[hsl(var(--accent))]'
            }`}
          >
            Upcoming
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {view === 'upcoming' && (
            <div
              className="inline-flex h-9 overflow-hidden rounded-md border border-[hsl(var(--border))]"
              aria-label="Upcoming media type"
            >
              {(['all', 'tv', 'movie'] as const).map((filter) => (
                <button
                  key={filter}
                  type="button"
                  aria-pressed={upcomingFilter === filter}
                  onClick={() => setUpcomingFilter(filter)}
                  className={`border-r border-[hsl(var(--border))] px-3 text-xs font-medium capitalize last:border-r-0 ${
                    upcomingFilter === filter
                      ? 'bg-[hsl(var(--accent))] text-[hsl(var(--foreground))]'
                      : 'text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]'
                  }`}
                >
                  {filter === 'tv' ? 'Shows' : filter === 'movie' ? 'Movies' : 'All'}
                </button>
              ))}
            </div>
          )}
          <label className="flex h-9 items-center gap-2 text-sm text-[hsl(var(--muted-foreground))]">
            <input
              type="checkbox"
              checked={includeSpecials}
              onChange={(event) => setIncludeSpecials(event.target.checked)}
              className="h-4 w-4 accent-cyan-600"
            />
            Specials
          </label>
        </div>
      </div>

      {mutationError && (
        <div className="mt-4 flex items-center gap-2 border-y border-[hsl(var(--destructive))]/40 py-3 text-sm text-[hsl(var(--destructive))]" role="alert">
          <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
          {mutationError}
        </div>
      )}

      <section className="mt-6" aria-live="polite" aria-busy={activeQuery.isLoading}>
        {activeQuery.isLoading ? (
          <CalendarSkeleton />
        ) : activeQuery.isError ? (
          <CalendarError onRetry={() => void activeQuery.refetch()} />
        ) : activeItems.length === 0 ? (
          <CalendarEmpty view={view} />
        ) : view === 'new' ? (
          <NewEpisodeList
            items={newItems}
            onPlan={(item) => setPlanned.mutate({
              episodeId: item.episode_id,
              planned: !item.is_planned,
            })}
            onWatched={(item) => markWatched.mutate(item.episode_id)}
            planPendingId={setPlanned.isPending ? setPlanned.variables?.episodeId : undefined}
            watchedPendingId={markWatched.isPending ? markWatched.variables : undefined}
          />
        ) : (
          <UpcomingList
            items={upcomingItems}
            onPlan={(item) => setPlanned.mutate({
              episodeId: item.item_id,
              planned: !item.is_planned,
            })}
            planPendingId={setPlanned.isPending ? setPlanned.variables?.episodeId : undefined}
          />
        )}
      </section>

      {hasNextPage && (
        <div ref={loadMoreRef} className="mt-6 flex justify-center">
          <button
            type="button"
            disabled={isFetchingNextPage}
            onClick={() => void fetchNextPage()}
            className="flex h-10 items-center gap-2 rounded-md border border-[hsl(var(--border))] px-4 text-sm font-medium hover:bg-[hsl(var(--accent))] disabled:opacity-50"
          >
            {isFetchingNextPage
              ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              : <ChevronDown className="h-4 w-4" aria-hidden="true" />}
            {view === 'new' ? 'Load older episodes' : 'Load later releases'}
          </button>
        </div>
      )}
    </div>
  );
}

function NewEpisodeList({
  items,
  onPlan,
  onWatched,
  planPendingId,
  watchedPendingId,
}: {
  items: CalendarEpisode[];
  onPlan: (item: CalendarEpisode) => void;
  onWatched: (item: CalendarEpisode) => void;
  planPendingId?: string;
  watchedPendingId?: string;
}) {
  const today = localDateKey();
  const planned = items.filter((item) => item.is_planned);
  const remaining = items.filter((item) => !item.is_planned);
  const groups = new Map<string, CalendarEpisode[]>();
  for (const item of remaining) {
    const bucket = newEpisodeBucket(item.air_date, today);
    groups.set(bucket, [...(groups.get(bucket) ?? []), item]);
  }

  return (
    <div className="space-y-7">
      {planned.length > 0 && (
        <CalendarGroup title="Watch next" icon={<BookmarkCheck className="h-4 w-4 text-amber-500" />}>
          {planned.map((item) => (
            <EpisodeRow
              key={item.episode_id}
              item={item}
              onPlan={() => onPlan(item)}
              onWatched={() => onWatched(item)}
              planPending={planPendingId === item.episode_id}
              watchedPending={watchedPendingId === item.episode_id}
            />
          ))}
        </CalendarGroup>
      )}
      {Array.from(groups.entries()).map(([title, groupItems]) => (
        <CalendarGroup key={title} title={title}>
          {groupItems.map((item) => (
            <EpisodeRow
              key={item.episode_id}
              item={item}
              onPlan={() => onPlan(item)}
              onWatched={() => onWatched(item)}
              planPending={planPendingId === item.episode_id}
              watchedPending={watchedPendingId === item.episode_id}
            />
          ))}
        </CalendarGroup>
      ))}
    </div>
  );
}

function UpcomingList({
  items,
  onPlan,
  planPendingId,
}: {
  items: UpcomingCalendarItem[];
  onPlan: (item: UpcomingCalendarItem) => void;
  planPendingId?: string;
}) {
  const groups = new Map<string, UpcomingCalendarItem[]>();
  for (const item of items) {
    groups.set(item.release_date, [...(groups.get(item.release_date) ?? []), item]);
  }

  return (
    <div className="space-y-7">
      {Array.from(groups.entries()).map(([date, groupItems]) => (
        <CalendarGroup key={date} title={formatCalendarDate(date)}>
          {groupItems.map((item) =>
            item.item_kind === 'episode' ? (
              <UpcomingEpisodeRow
                key={`${item.item_id}:${item.release_type ?? 'episode'}`}
                item={item}
                onPlan={() => onPlan(item)}
                planPending={planPendingId === item.item_id}
              />
            ) : (
              <MovieReleaseRow
                key={`${item.item_id}:${item.release_type ?? 'default'}`}
                item={item}
              />
            ),
          )}
        </CalendarGroup>
      ))}
    </div>
  );
}

function CalendarGroup({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section aria-label={title}>
      <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold uppercase text-[hsl(var(--muted-foreground))]">
        {icon}
        {title}
      </h2>
      <div className="divide-y divide-[hsl(var(--border))] border-y border-[hsl(var(--border))]">
        {children}
      </div>
    </section>
  );
}

function EpisodeRow({
  item,
  onPlan,
  onWatched,
  planPending,
  watchedPending,
}: {
  item: CalendarEpisode;
  onPlan: () => void;
  onWatched: () => void;
  planPending: boolean;
  watchedPending: boolean;
}) {
  return (
    <article className="flex min-h-24 items-center gap-3 py-3 sm:gap-4">
      <EpisodeImage stillPath={item.still_path} posterPath={item.poster_path} title={item.title} />
      <div className="min-w-0 flex-1">
        <Link
          to={`/media/${item.tmdb_id}?type=tv`}
          className="text-sm font-semibold hover:text-cyan-600 dark:hover:text-cyan-400"
        >
          {item.title}
        </Link>
        <p className="mt-0.5 truncate text-sm">
          <span className="mr-2 font-mono text-xs text-[hsl(var(--muted-foreground))]">
            {episodeCode(item.season_number, item.episode_number)}
          </span>
          {item.episode_name || `Episode ${item.episode_number}`}
        </p>
        <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-[hsl(var(--muted-foreground))]">
          <span>{formatCalendarDate(item.air_date, false)}</span>
          {item.runtime_minutes != null && <span>{formatRuntime(item.runtime_minutes)}</span>}
        </div>
      </div>
      <EpisodeActions
        episodeName={item.episode_name || `Episode ${item.episode_number}`}
        planned={item.is_planned}
        onPlan={onPlan}
        onWatched={onWatched}
        planPending={planPending}
        watchedPending={watchedPending}
      />
    </article>
  );
}

function UpcomingEpisodeRow({
  item,
  onPlan,
  planPending,
}: {
  item: UpcomingCalendarItem;
  onPlan: () => void;
  planPending: boolean;
}) {
  const episodeName = item.episode_name || `Episode ${item.episode_number}`;
  return (
    <article className="flex min-h-24 items-center gap-3 py-3 sm:gap-4">
      <EpisodeImage stillPath={item.still_path} posterPath={item.poster_path} title={item.title} />
      <div className="min-w-0 flex-1">
        <Link
          to={`/media/${item.tmdb_id}?type=tv`}
          className="text-sm font-semibold hover:text-cyan-600 dark:hover:text-cyan-400"
        >
          {item.title}
        </Link>
        <p className="mt-0.5 truncate text-sm">
          <span className="mr-2 font-mono text-xs text-[hsl(var(--muted-foreground))]">
            {episodeCode(item.season_number ?? 0, item.episode_number ?? 0)}
          </span>
          {episodeName}
        </p>
      </div>
      <button
        type="button"
        aria-label={item.is_planned ? `Remove ${episodeName} from Watch next` : `Add ${episodeName} to Watch next`}
        title={item.is_planned ? 'Remove from Watch next' : 'Add to Watch next'}
        disabled={planPending}
        onClick={onPlan}
        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-md border transition-colors disabled:opacity-50 ${
          item.is_planned
            ? 'border-amber-500 bg-amber-500/10 text-amber-600 dark:text-amber-400'
            : 'border-[hsl(var(--border))] hover:border-amber-500 hover:text-amber-600'
        }`}
      >
        {planPending
          ? <Loader2 className="h-4 w-4 animate-spin" />
          : item.is_planned
            ? <BookmarkCheck className="h-4 w-4" />
            : <Bookmark className="h-4 w-4" />}
      </button>
    </article>
  );
}

function MovieReleaseRow({ item }: { item: UpcomingCalendarItem }) {
  return (
    <article className="flex min-h-24 items-center gap-3 py-3 sm:gap-4">
      <img
        src={getPosterUrl(item.poster_path, 'w92')}
        alt=""
        className="h-20 w-14 shrink-0 rounded object-cover bg-[hsl(var(--muted))]"
        loading="lazy"
      />
      <div className="min-w-0 flex-1">
        <Link
          to={`/media/${item.tmdb_id}?type=movie`}
          className="font-semibold hover:text-cyan-600 dark:hover:text-cyan-400"
        >
          {item.title}
        </Link>
        <div className="mt-1 flex items-center gap-2 text-xs text-[hsl(var(--muted-foreground))]">
          <Film className="h-3.5 w-3.5" aria-hidden="true" />
          {item.release_type != null ? RELEASE_TYPE_LABELS[item.release_type] ?? 'Release' : 'Release'}
        </div>
      </div>
    </article>
  );
}

function EpisodeImage({
  stillPath,
  posterPath,
  title,
}: {
  stillPath: string | null;
  posterPath: string | null;
  title: string;
}) {
  return (
    <div className="flex h-16 w-24 shrink-0 items-center justify-center overflow-hidden rounded bg-[hsl(var(--muted))] sm:h-20 sm:w-32">
      <img
        src={getPosterUrl(stillPath ?? posterPath, stillPath ? 'w300' : 'w92')}
        alt=""
        title={title}
        className={`h-full w-full ${stillPath ? 'object-cover' : 'object-contain'}`}
        loading="lazy"
      />
    </div>
  );
}

function EpisodeActions({
  episodeName,
  planned,
  onPlan,
  onWatched,
  planPending,
  watchedPending,
}: {
  episodeName: string;
  planned: boolean;
  onPlan: () => void;
  onWatched: () => void;
  planPending: boolean;
  watchedPending: boolean;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2">
      <button
        type="button"
        aria-label={planned ? `Remove ${episodeName} from Watch next` : `Add ${episodeName} to Watch next`}
        title={planned ? 'Remove from Watch next' : 'Add to Watch next'}
        disabled={planPending || watchedPending}
        onClick={onPlan}
        className={`flex h-10 w-10 items-center justify-center rounded-md border transition-colors disabled:opacity-50 ${
          planned
            ? 'border-amber-500 bg-amber-500/10 text-amber-600 dark:text-amber-400'
            : 'border-[hsl(var(--border))] hover:border-amber-500 hover:text-amber-600'
        }`}
      >
        {planPending
          ? <Loader2 className="h-4 w-4 animate-spin" />
          : planned
            ? <BookmarkCheck className="h-4 w-4" />
            : <Bookmark className="h-4 w-4" />}
      </button>
      <button
        type="button"
        aria-label={`Mark ${episodeName} watched`}
        title="Mark watched"
        disabled={planPending || watchedPending}
        onClick={onWatched}
        className="flex h-10 w-10 items-center justify-center rounded-md border border-[hsl(var(--border))] transition-colors hover:border-emerald-500 hover:bg-emerald-500/10 hover:text-emerald-600 disabled:opacity-50 dark:hover:text-emerald-400"
      >
        {watchedPending
          ? <Loader2 className="h-4 w-4 animate-spin" />
          : <Check className="h-4 w-4" />}
      </button>
    </div>
  );
}

function CalendarSkeleton() {
  return (
    <div className="animate-pulse divide-y divide-[hsl(var(--border))] border-y border-[hsl(var(--border))]" role="status">
      <span className="sr-only">Loading calendar</span>
      {Array.from({ length: 5 }, (_, index) => (
        <div key={index} className="flex h-24 items-center gap-4 py-3" aria-hidden="true">
          <div className="h-16 w-24 rounded bg-[hsl(var(--muted))] sm:h-20 sm:w-32" />
          <div className="flex-1 space-y-2">
            <div className="h-4 w-40 rounded bg-[hsl(var(--muted))]" />
            <div className="h-3 w-56 max-w-full rounded bg-[hsl(var(--muted))]" />
          </div>
          <div className="h-10 w-10 rounded bg-[hsl(var(--muted))]" />
        </div>
      ))}
    </div>
  );
}

function CalendarError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex items-center justify-between gap-4 border-y border-[hsl(var(--border))] py-6">
      <div className="flex items-center gap-3 text-sm text-[hsl(var(--destructive))]">
        <AlertCircle className="h-5 w-5" aria-hidden="true" />
        Calendar unavailable
      </div>
      <button
        type="button"
        onClick={onRetry}
        title="Retry"
        aria-label="Retry calendar"
        className="flex h-10 w-10 items-center justify-center rounded-md border border-[hsl(var(--border))] hover:bg-[hsl(var(--accent))]"
      >
        <RefreshCw className="h-4 w-4" />
      </button>
    </div>
  );
}

function CalendarEmpty({ view }: { view: CalendarView }) {
  return (
    <div className="flex min-h-56 flex-col items-center justify-center border-y border-[hsl(var(--border))] text-center text-[hsl(var(--muted-foreground))]">
      {view === 'new'
        ? <Tv className="mb-3 h-7 w-7" aria-hidden="true" />
        : <Clock3 className="mb-3 h-7 w-7" aria-hidden="true" />}
      <p className="text-sm font-medium text-[hsl(var(--foreground))]">
        {view === 'new' ? 'No new episodes' : 'Nothing scheduled'}
      </p>
    </div>
  );
}
