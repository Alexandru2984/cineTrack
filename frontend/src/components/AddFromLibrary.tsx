import { useEffect, useMemo, useState } from 'react';
import { Check, Loader2, Plus, Search } from 'lucide-react';

import { useAddListItem } from '@/hooks/useLists';
import { useTrackingInfinite } from '@/hooks/useTracking';
import { getApiErrorMessage } from '@/lib/api';
import { getPosterUrl } from '@/lib/utils';
import { useT } from '@/hooks/useT';
import type { TrackingItem } from '@/types';

/** Fill a list from the library, without leaving the list.
 *
 *  An empty list used to say "open a movie or show and use Custom list to add
 *  it here" — it sent you somewhere else and asked you to come back, once per
 *  title. Eleven accounts have made zero lists between them.
 *
 *  The titles somebody wants in a list are, nearly always, ones they have
 *  already tracked. Those carry the internal media id the API needs, so this
 *  needs nothing new from the backend.
 */
export function AddFromLibrary({
  listId,
  alreadyIn,
}: {
  listId: string;
  /** Media ids already in the list, so they can be shown as done rather than
   *  offered again and silently ignored by `ON CONFLICT DO NOTHING`. */
  alreadyIn: Set<string>;
}) {
  const t = useT();
  const [filter, setFilter] = useState('');
  const [justAdded, setJustAdded] = useState<Set<string>>(new Set());
  const library = useTrackingInfinite();
  const addItem = useAddListItem();

  // Filtering only what happens to be on the first page would quietly hide
  // most of a library from its own search box. Pages hold a hundred each, so
  // an ordinary library is a request or two.
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = library;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const items = useMemo(() => {
    const pages: TrackingItem[][] = library.data?.pages ?? [];
    const all = pages.flat();
    // One row per title. The library is keyed by tracking entry, and the same
    // media can appear more than once across pages while they are loading.
    const unique = new Map<string, TrackingItem>();
    for (const item of all) unique.set(item.media_id, item);

    const needle = filter.trim().toLowerCase();
    const matching = [...unique.values()].filter(
      (item) => !needle || item.title.toLowerCase().includes(needle),
    );
    matching.sort((left, right) => left.title.localeCompare(right.title));
    return matching;
  }, [library.data, filter]);

  const isLoading = library.isLoading || library.hasNextPage === true;

  return (
    <section className="mt-6 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-4">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <Plus className="h-4 w-4 text-[hsl(var(--primary))]" aria-hidden="true" />
        {t('listDetail.addTitle')}
      </h2>

      <div className="relative mt-3">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[hsl(var(--muted-foreground))]"
          aria-hidden="true"
        />
        <input
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={t('listDetail.addFilter')}
          aria-label={t('listDetail.addFilter')}
          className="w-full rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] py-2 pl-9 pr-3 text-sm"
        />
      </div>

      {isLoading ? (
        <p className="mt-4 flex items-center gap-2 text-sm text-[hsl(var(--muted-foreground))]">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          {t('listDetail.addLoading')}
        </p>
      ) : items.length === 0 ? (
        <p className="mt-4 text-sm text-[hsl(var(--muted-foreground))]">
          {filter.trim() ? t('listDetail.addNoMatch') : t('listDetail.addNoLibrary')}
        </p>
      ) : (
        <ul className="mt-3 max-h-80 space-y-1 overflow-y-auto">
          {items.map((item) => {
            const added = alreadyIn.has(item.media_id) || justAdded.has(item.media_id);
            return (
              <li key={item.media_id}>
                <button
                  type="button"
                  disabled={added || addItem.isPending}
                  onClick={() => {
                    addItem.mutate(
                      { listId, mediaId: item.media_id },
                      {
                        // Kept locally as well as invalidating: the refetch is
                        // not instant, and a button that stays clickable after
                        // a successful click invites a second one.
                        onSuccess: () =>
                          setJustAdded((current) => new Set(current).add(item.media_id)),
                      },
                    );
                  }}
                  className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-[hsl(var(--accent))] disabled:opacity-60 disabled:hover:bg-transparent"
                >
                  <img
                    src={getPosterUrl(item.poster_path)}
                    alt=""
                    loading="lazy"
                    className="h-12 w-8 shrink-0 rounded object-cover"
                  />
                  <span className="min-w-0 flex-1 truncate text-sm">{item.title}</span>
                  {added ? (
                    <span className="flex shrink-0 items-center gap-1 text-xs text-[hsl(var(--muted-foreground))]">
                      <Check className="h-4 w-4" aria-hidden="true" />
                      {t('listDetail.addAlready')}
                    </span>
                  ) : (
                    <Plus
                      className="h-4 w-4 shrink-0 text-[hsl(var(--muted-foreground))]"
                      aria-hidden="true"
                    />
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {addItem.error ? (
        <p className="mt-3 text-sm text-[hsl(var(--destructive))]" role="alert">
          {getApiErrorMessage(addItem.error, t('listDetail.updateError'))}
        </p>
      ) : null}
    </section>
  );
}
