import { useState } from 'react';
import { useTrackingInfinite, useUpdateTracking, useDeleteTracking } from '@/hooks/useTracking';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { getPosterUrl, STATUS_LABELS, STATUS_COLORS } from '@/lib/utils';
import { Loader2, Star, Trash2, Heart } from 'lucide-react';
import { Link } from 'react-router-dom';
import { TrackingFeedbackDialog } from '@/components/TrackingFeedbackDialog';
import { getApiErrorMessage } from '@/lib/api';
import type { TrackingItem } from '@/types';

const TABS = ['all', 'watching', 'plan_to_watch', 'completed', 'on_hold', 'dropped'] as const;

export default function TrackingPage() {
  const [tab, setTab] = useState<string>('all');
  const [feedbackItem, setFeedbackItem] = useState<TrackingItem | null>(null);
  const tracking = useTrackingInfinite(tab === 'all' ? undefined : tab);
  const items = tracking.data?.pages.flatMap((page) => page) ?? [];
  const updateTracking = useUpdateTracking();
  const deleteTracking = useDeleteTracking();

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:py-8">
      <h1 className="text-2xl font-bold sm:text-3xl">My List</h1>

      {/* Tabs */}
      <div
        role="tablist"
        aria-label="Library status"
        className="sticky top-[calc(3.5rem+env(safe-area-inset-top))] z-30 -mx-4 flex gap-2 overflow-x-auto border-y border-[hsl(var(--border))] bg-[hsl(var(--background))]/95 px-4 py-3 backdrop-blur md:static md:mx-0 md:border-0 md:bg-transparent md:px-0 md:py-0 md:pb-2 md:backdrop-blur-none"
      >
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`min-h-10 shrink-0 whitespace-nowrap rounded-md px-4 text-sm font-medium transition-colors ${
              tab === t
                ? 'bg-[hsl(var(--primary))] text-white'
                : 'border border-[hsl(var(--border))] hover:bg-[hsl(var(--secondary))]'
            }`}
          >
            {t === 'all' ? 'All' : STATUS_LABELS[t]}
          </button>
        ))}
      </div>

      {tracking.isLoading && <LoadingSpinner />}

      {!tracking.isLoading && !tracking.isError && items.length === 0 && (
        <div className="text-center py-16 text-[hsl(var(--muted-foreground))]">
          <p>No items yet. Start by searching and adding movies or shows!</p>
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
                <span className="text-xs text-[hsl(var(--muted-foreground))]">{STATUS_LABELS[item.status]}</span>
                <span className="text-xs text-[hsl(var(--muted-foreground))] capitalize">{item.media_type}</span>
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
                aria-label={`Status for ${item.title}`}
                value={item.status}
                onChange={(e) => updateTracking.mutate({ id: item.id, status: e.target.value })}
                className="h-10 min-w-0 flex-1 rounded-md border border-[hsl(var(--input))] bg-transparent px-2 text-sm sm:w-36 sm:flex-none sm:text-xs"
              >
                {Object.entries(STATUS_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
              <button
                type="button"
                title={`Edit rating and review for ${item.title}`}
                aria-label={`Edit rating and review for ${item.title}`}
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
                title={item.is_favorite ? `Remove ${item.title} from favorites` : `Add ${item.title} to favorites`}
                aria-label={item.is_favorite ? `Remove ${item.title} from favorites` : `Add ${item.title} to favorites`}
                onClick={() => updateTracking.mutate({ id: item.id, is_favorite: !item.is_favorite })}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-[hsl(var(--border))]"
              >
                <Heart className={`h-4 w-4 ${item.is_favorite ? 'fill-red-500 text-red-500' : 'text-[hsl(var(--muted-foreground))]'}`} />
              </button>
              <button
                type="button"
                title={`Remove ${item.title} from your list`}
                aria-label={`Remove ${item.title} from your list`}
                onClick={() => { if (confirm('Remove from list?')) deleteTracking.mutate(item.id); }}
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
          <p>Your library could not be loaded.</p>
          <button
            type="button"
            onClick={() => tracking.refetch()}
            className="mt-3 h-10 rounded-md border border-[hsl(var(--border))] px-4 font-medium"
          >
            Try again
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
            Load more
          </button>
        </div>
      )}
      {feedbackItem && (
        <TrackingFeedbackDialog
          item={feedbackItem}
          pending={updateTracking.isPending}
          error={updateTracking.error
            ? getApiErrorMessage(updateTracking.error, 'Your rating could not be saved')
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
