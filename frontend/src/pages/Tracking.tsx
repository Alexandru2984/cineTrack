import { useEffect, useState } from 'react';
import {
  useExportLibrary,
  useTrackingInfinite,
  useTrackingFacets,
  useUpdateTracking,
  useDeleteTracking,
  type LibraryFilters,
  type LibrarySort,
} from '@/hooks/useTracking';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { getPosterUrl, STATUS_COLORS } from '@/lib/utils';
import { Download, Loader2, Star, Trash2, Heart, ListPlus, Search, X } from 'lucide-react';
import { Link, useSearchParams } from 'react-router';
import { TrackingFeedbackDialog } from '@/components/TrackingFeedbackDialog';
import { getApiErrorMessage } from '@/lib/api';
import { useT } from '@/hooks/useT';
import { useLocaleStore } from '@/store/locale';
import type { TrackingFacets, TrackingItem } from '@/types';

const TABS = ['all', 'watching', 'plan_to_watch', 'completed', 'on_hold', 'dropped'] as const;
const STATUSES = ['watching', 'plan_to_watch', 'completed', 'on_hold', 'dropped'] as const;
const SORTS: readonly LibrarySort[] = ['updated', 'added', 'title', 'rating', 'release'];
const SORT_LABELS: Record<LibrarySort, string> = {
  updated: 'tracking.sortUpdated',
  added: 'tracking.sortAdded',
  title: 'tracking.sortTitle',
  rating: 'tracking.sortRating',
  release: 'tracking.sortRelease',
};
/** How long typing pauses before the search runs. */
const SEARCH_DELAY_MS = 300;

/** The filters live in the address, so a filtered view survives a reload, the
 *  back button and a shared link. Anything unrecognised is ignored. */
function readFilters(params: URLSearchParams): LibraryFilters {
  const status = params.get('status');
  const type = params.get('type');
  const genre = params.get('genre');
  const sort = params.get('sort');
  return {
    status: STATUSES.find((candidate) => candidate === status),
    mediaType: type === 'movie' || type === 'tv' ? type : undefined,
    genre: genre && (genre === 'anime' || /^[1-9]\d{0,8}$/.test(genre)) ? genre : undefined,
    favorite: params.get('favorite') === '1' || undefined,
    q: params.get('q')?.trim() || undefined,
    sort: SORTS.find((candidate) => candidate === sort),
  };
}

export default function TrackingPage() {
  const t = useT();
  const locale = useLocaleStore((state) => state.locale);
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = readFilters(searchParams);
  const urlQuery = filters.q ?? '';
  const [query, setQuery] = useState(urlQuery);
  // The address can change under the box too — the back button, a link — and
  // the box follows it then. Not when the address is just catching up with
  // what is being typed, or a trailing space would vanish mid-word.
  const [seenUrlQuery, setSeenUrlQuery] = useState(urlQuery);
  if (urlQuery !== seenUrlQuery) {
    setSeenUrlQuery(urlQuery);
    if (query.trim() !== urlQuery) setQuery(urlQuery);
  }
  const [feedbackItem, setFeedbackItem] = useState<TrackingItem | null>(null);
  const tracking = useTrackingInfinite(filters);
  const facets = useTrackingFacets(filters, locale);
  const items = tracking.data?.pages.flatMap((page) => page) ?? [];
  const updateTracking = useUpdateTracking();
  const deleteTracking = useDeleteTracking();
  const exportLibrary = useExportLibrary();
  const tab = filters.status ?? 'all';
  const narrowed = Boolean(filters.mediaType || filters.genre || filters.favorite || filters.q);

  const setFilters = (changes: Record<string, string | null>) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      for (const [key, value] of Object.entries(changes)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      return next;
    }, { replace: true });
  };

  // Typing updates the box at once and the address once it pauses.
  useEffect(() => {
    if (query.trim() === urlQuery) return;
    const timer = window.setTimeout(() => setFilters({ q: query.trim() || null }), SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
    // setFilters is rebuilt every render; the query is what this waits on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, urlQuery]);

  const clearFilters = () => {
    setQuery('');
    setFilters({ type: null, genre: null, favorite: null, q: null });
  };

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:py-8">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-bold sm:text-3xl">{t('nav.myList')}</h1>
        <div className="flex shrink-0 gap-2">
          {/* What is on screen, filters and order included. */}
          <button
            type="button"
            disabled={exportLibrary.isPending}
            onClick={() => exportLibrary.mutate({ filters, language: locale })}
            title={t('tracking.exportCsvHint')}
            className="flex h-10 items-center gap-2 rounded-md border border-[hsl(var(--border))] px-3 text-sm font-medium disabled:opacity-50"
          >
            {exportLibrary.isPending
              ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              : <Download className="h-4 w-4" aria-hidden="true" />}
            <span className="sr-only sm:not-sr-only">{t('tracking.exportCsv')}</span>
          </button>
          <Link
            to="/lists"
            className="flex h-10 items-center gap-2 rounded-md border border-[hsl(var(--border))] px-3 text-sm font-medium"
          >
            <ListPlus className="h-4 w-4" aria-hidden="true" />
            {t('tracking.customLists')}
          </Link>
        </div>
      </div>
      {exportLibrary.isError && (
        <p role="alert" className="text-sm text-[hsl(var(--destructive))]">
          {t('tracking.exportError')}
        </p>
      )}

      {/* Tabs */}
      <div
        role="tablist"
        aria-label={t('tracking.libraryStatus')}
        className="sticky top-[calc(3.5rem+env(safe-area-inset-top))] z-30 -mx-4 flex gap-2 overflow-x-auto border-y border-[hsl(var(--border))] bg-[hsl(var(--background))]/95 px-4 py-3 backdrop-blur md:static md:mx-0 md:border-0 md:bg-transparent md:px-0 md:py-0 md:pb-2 md:backdrop-blur-none"
      >
        {TABS.map((tabKey) => (
          <button
            key={tabKey}
            type="button"
            role="tab"
            aria-selected={tab === tabKey}
            onClick={() => setFilters({ status: tabKey === 'all' ? null : tabKey })}
            className={`min-h-10 shrink-0 whitespace-nowrap rounded-md px-4 text-sm font-medium transition-colors ${
              tab === tabKey
                ? 'bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]'
                : 'border border-[hsl(var(--border))] hover:bg-[hsl(var(--secondary))]'
            }`}
          >
            {tabKey === 'all' ? t('tracking.all') : t(`status.${tabKey}`)}
            {facets.data && ' '}
            {facets.data && (
              <span className="tabular-nums opacity-75">
                {tabKey === 'all'
                  ? Object.values(facets.data.statuses).reduce((sum, count) => sum + (count ?? 0), 0)
                  : facets.data.statuses[tabKey] ?? 0}
              </span>
            )}
          </button>
        ))}
      </div>

      <LibraryFilterBar
        filters={filters}
        facets={facets.data}
        query={query}
        onQueryChange={setQuery}
        onChange={setFilters}
        onClear={narrowed ? clearFilters : undefined}
      />

      {facets.data && (
        <p aria-live="polite" className="text-sm text-[hsl(var(--muted-foreground))]">
          {facets.data.total === 1
            ? t('tracking.countOne')
            : t('tracking.countMany', { count: facets.data.total })}
        </p>
      )}

      {tracking.isLoading && <LoadingSpinner />}

      {!tracking.isLoading && !tracking.isError && items.length === 0 && (
        <div className="text-center py-16 text-[hsl(var(--muted-foreground))]">
          {narrowed ? (
            <>
              <p>{t('tracking.noMatches')}</p>
              <button
                type="button"
                onClick={clearFilters}
                className="mt-3 h-10 rounded-md border border-[hsl(var(--border))] px-4 text-sm font-medium text-[hsl(var(--foreground))]"
              >
                {t('tracking.clearFilters')}
              </button>
            </>
          ) : (
            <p>{t('tracking.empty')}</p>
          )}
        </div>
      )}

      <div className="space-y-3">
        {items.map((item) => (
          <article
            key={item.id}
            className="flex flex-wrap items-center gap-3 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-3 sm:flex-nowrap sm:gap-4"
          >
            <Link to={`/media/${item.tmdb_id}?type=${item.media_type}`}>
              <img
                src={getPosterUrl(item.poster_path, 'w92')}
                alt={item.title}
                className="h-20 w-14 rounded object-cover"
              />
            </Link>
            <div className="flex-1 min-w-0">
              <Link to={`/media/${item.tmdb_id}?type=${item.media_type}`} className="font-medium hover:text-[hsl(var(--primary))]">
                {item.title}
              </Link>
              <div className="flex items-center gap-2 mt-1">
                <span className={`inline-block h-2 w-2 rounded-full ${STATUS_COLORS[item.status]}`} />
                <span className="text-xs text-[hsl(var(--muted-foreground))]">{t(`status.${item.status}`)}</span>
                <span className="text-xs text-[hsl(var(--muted-foreground))]">{t(`mediaType.${item.media_type}`)}</span>
                {item.release_date && (
                  <span className="text-xs tabular-nums text-[hsl(var(--muted-foreground))]">
                    {item.release_date.slice(0, 4)}
                  </span>
                )}
              </div>
              {item.rating && (
                <div className="flex items-center gap-1 mt-1">
                  <Star className="h-3 w-3 fill-yellow-400 text-yellow-400" />
                  <span className="text-xs">{item.rating}/10</span>
                </div>
              )}
              {item.review && (
                <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-[hsl(var(--muted-foreground))]">
                  {item.review}
                </p>
              )}
            </div>
            <div className="flex w-full shrink-0 items-center gap-2 border-t border-[hsl(var(--border))] pt-3 sm:w-auto sm:border-0 sm:pt-0">
              <select
                aria-label={t('tracking.statusFor', { title: item.title })}
                value={item.status}
                onChange={(event) => {
                  const status = STATUSES.find(
                    (candidate) => candidate === event.target.value,
                  );
                  if (status) updateTracking.mutate({ id: item.id, status });
                }}
                className="h-10 min-w-0 flex-1 rounded-md border border-[hsl(var(--input))] bg-transparent px-2 text-sm sm:w-36 sm:flex-none sm:text-xs"
              >
                {STATUSES.map((k) => (
                  <option key={k} value={k}>{t(`status.${k}`)}</option>
                ))}
              </select>
              <button
                type="button"
                title={t('tracking.editRatingFor', { title: item.title })}
                aria-label={t('tracking.editRatingFor', { title: item.title })}
                onClick={() => {
                  updateTracking.reset();
                  setFeedbackItem(item);
                }}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-[hsl(var(--border))]"
              >
                <Star className={`h-4 w-4 ${item.rating ? 'fill-yellow-400 text-yellow-400' : 'text-[hsl(var(--muted-foreground))]'}`} />
              </button>
              <button
                type="button"
                title={item.is_favorite ? t('tracking.removeFavorite', { title: item.title }) : t('tracking.addFavorite', { title: item.title })}
                aria-label={item.is_favorite ? t('tracking.removeFavorite', { title: item.title }) : t('tracking.addFavorite', { title: item.title })}
                onClick={() => updateTracking.mutate({ id: item.id, is_favorite: !item.is_favorite })}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-[hsl(var(--border))]"
              >
                <Heart className={`h-4 w-4 ${item.is_favorite ? 'fill-red-500 text-red-500' : 'text-[hsl(var(--muted-foreground))]'}`} />
              </button>
              <button
                type="button"
                title={t('tracking.removeFromList', { title: item.title })}
                aria-label={t('tracking.removeFromList', { title: item.title })}
                onClick={() => { if (confirm(t('tracking.confirmRemove'))) deleteTracking.mutate(item.id); }}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-[hsl(var(--border))] text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--destructive))]"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          </article>
        ))}
      </div>
      {tracking.isError && (
        <div className="text-center text-sm text-[hsl(var(--destructive))]">
          <p>{t('tracking.loadError')}</p>
          <button
            type="button"
            onClick={() => tracking.refetch()}
            className="mt-3 h-10 rounded-md border border-[hsl(var(--border))] px-4 font-medium"
          >
            {t('common.tryAgain')}
          </button>
        </div>
      )}
      {tracking.hasNextPage && (
        <div className="flex justify-center">
          <button
            type="button"
            disabled={tracking.isFetchingNextPage}
            onClick={() => tracking.fetchNextPage()}
            className="flex h-10 items-center gap-2 rounded-md border border-[hsl(var(--border))] px-4 text-sm font-medium disabled:opacity-50"
          >
            {tracking.isFetchingNextPage && (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            )}
            {t('common.loadMore')}
          </button>
        </div>
      )}
      {feedbackItem && (
        <TrackingFeedbackDialog
          item={feedbackItem}
          pending={updateTracking.isPending}
          error={updateTracking.error
            ? getApiErrorMessage(updateTracking.error, t('tracking.ratingSaveError'))
            : undefined}
          onClose={() => {
            if (!updateTracking.isPending) setFeedbackItem(null);
          }}
          onSave={(payload) => updateTracking.mutate(
            { id: feedbackItem.id, ...payload },
            { onSuccess: () => setFeedbackItem(null) },
          )}
        />
      )}
    </div>
  );
}

// `min-w-0 w-full`: a select is as wide as its longest option unless told
// otherwise, and a long genre name would push a 320px screen sideways.
const CONTROL =
  'h-10 w-full min-w-0 rounded-md border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-2 text-sm sm:w-auto';

interface LibraryFilterBarProps {
  filters: LibraryFilters;
  facets: TrackingFacets | undefined;
  query: string;
  onQueryChange: (query: string) => void;
  onChange: (changes: Record<string, string | null>) => void;
  /** Present only while something narrows the list. */
  onClear?: () => void;
}

/** Search, type, genre, favourites and order. Each choice shows how many
 *  titles it would leave, given the others. */
function LibraryFilterBar({
  filters,
  facets,
  query,
  onQueryChange,
  onChange,
  onClear,
}: LibraryFilterBarProps) {
  const t = useT();
  const counted = (label: string, count: number | undefined) =>
    count === undefined ? label : t('tracking.optionCount', { label, count });
  const typeCount = (type: 'movie' | 'tv') => facets && (facets.media_types[type] ?? 0);

  return (
    <div
      role="group"
      aria-label={t('tracking.filters')}
      className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center"
    >
      <label className="relative col-span-2 sm:min-w-56 sm:flex-1">
        <span className="sr-only">{t('tracking.search')}</span>
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[hsl(var(--muted-foreground))]"
          aria-hidden="true"
        />
        <input
          type="search"
          value={query}
          maxLength={100}
          placeholder={t('tracking.searchPlaceholder')}
          onChange={(event) => onQueryChange(event.target.value)}
          className={`${CONTROL} pl-9 sm:w-full`}
        />
      </label>
      <select
        aria-label={t('tracking.type')}
        value={filters.mediaType ?? ''}
        onChange={(event) => onChange({ type: event.target.value || null })}
        className={CONTROL}
      >
        <option value="">{t('tracking.typeAll')}</option>
        <option value="movie">{counted(t('tracking.typeMovie'), typeCount('movie'))}</option>
        <option value="tv">{counted(t('tracking.typeTv'), typeCount('tv'))}</option>
      </select>
      <select
        aria-label={t('tracking.genre')}
        value={filters.genre ?? ''}
        onChange={(event) => onChange({ genre: event.target.value || null })}
        className={CONTROL}
      >
        <option value="">{t('tracking.genreAll')}</option>
        {(filters.genre === 'anime' || (facets?.anime ?? 0) > 0) && (
          <option value="anime">{counted(t('tracking.anime'), facets?.anime)}</option>
        )}
        {facets?.genres.map((genre) => (
          <option key={genre.id} value={String(genre.id)}>
            {counted(genre.name, genre.count)}
          </option>
        ))}
      </select>
      <select
        aria-label={t('tracking.sort')}
        value={filters.sort ?? 'updated'}
        onChange={(event) => onChange({ sort: event.target.value === 'updated' ? null : event.target.value })}
        className={CONTROL}
      >
        {SORTS.map((sort) => (
          <option key={sort} value={sort}>{t(SORT_LABELS[sort])}</option>
        ))}
      </select>
      <button
        type="button"
        aria-pressed={Boolean(filters.favorite)}
        onClick={() => onChange({ favorite: filters.favorite ? null : '1' })}
        className={`flex h-10 items-center justify-center gap-2 rounded-md border px-3 text-sm font-medium ${
          filters.favorite
            ? 'border-red-500 bg-red-500/10'
            : 'border-[hsl(var(--border))] hover:bg-[hsl(var(--secondary))]'
        }`}
      >
        <Heart
          className={`h-4 w-4 ${filters.favorite ? 'fill-red-500 text-red-500' : 'text-[hsl(var(--muted-foreground))]'}`}
          aria-hidden="true"
        />
        {counted(t('tracking.favoritesOnly'), facets?.favorites)}
      </button>
      {onClear && (
        <button
          type="button"
          onClick={onClear}
          className="col-span-2 flex h-10 items-center justify-center gap-2 rounded-md px-3 text-sm font-medium text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] sm:col-span-1"
        >
          <X className="h-4 w-4" aria-hidden="true" />
          {t('tracking.clearFilters')}
        </button>
      )}
    </div>
  );
}
