import { Link } from 'react-router';
import { getPosterUrl } from '@/lib/utils';
import type { TmdbSearchResult, TrackingStatus } from '@/types';
import { Star, Plus, Eye, BookmarkPlus } from 'lucide-react';
import { useCreateTracking } from '@/hooks/useTracking';
import { useState } from 'react';
import { useT } from '@/hooks/useT';
import { getApiErrorMessage } from '@/lib/api';

interface Props {
  item: TmdbSearchResult;
  showQuickAdd?: boolean;
  trackingStatus?: TrackingStatus | null;
}

export function MediaCard({
  item,
  showQuickAdd = false,
  trackingStatus = null,
}: Props) {
  const t = useT();
  const title = item.title || item.name || t('mediaCard.unknown');
  const date = item.release_date || item.first_air_date;
  const type = item.media_type === 'tv' ? 'tv' : 'movie';
  const year = date ? new Date(date).getFullYear() : '';
  const createTracking = useCreateTracking();
  const [added, setAdded] = useState<TrackingStatus | null>(null);
  const savedStatus = added ?? trackingStatus;
  const detailPath = `/media/${item.id}?type=${type}`;

  const handleQuickAdd = (status: TrackingStatus) => {
    createTracking.mutate(
      { tmdb_id: item.id, media_type: type, status },
      { onSuccess: () => setAdded(status) },
    );
  };

  return (
    <article
      className="media-card group block rounded-lg overflow-hidden border border-[hsl(var(--border))] bg-[hsl(var(--card))] hover:border-[hsl(var(--primary))] transition-colors"
    >
      <div className="aspect-[2/3] relative overflow-hidden bg-[hsl(var(--muted))]">
        <Link
          to={detailPath}
          aria-label={t('mediaCard.open', { title })}
          className="block h-full w-full"
        >
          <img
            src={getPosterUrl(item.poster_path)}
            alt={title}
            className="h-full w-full object-cover group-hover:scale-105 transition-transform duration-300"
            loading="lazy"
          />
        </Link>
        {item.vote_average != null && item.vote_average > 0 && (
          <div className="absolute top-2 right-2 flex items-center gap-1 rounded-full bg-black/70 px-2 py-0.5 text-xs text-white">
            <Star className="h-3 w-3 fill-yellow-400 text-yellow-400" aria-hidden="true" />
            {item.vote_average.toFixed(1)}
          </div>
        )}
        <div className="absolute top-2 left-2 rounded-full bg-[hsl(var(--primary))]/90 px-2 py-0.5 text-xs text-white">
          {type === 'tv' ? t('mediaType.tv') : t('mediaType.movie')}
        </div>
        {showQuickAdd && !savedStatus && (
          <div className="media-card-actions absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-2 opacity-100 transition-opacity">
            <div className="flex gap-1 justify-center">
              <button
                type="button"
                onClick={() => handleQuickAdd('watching')}
                disabled={createTracking.isPending}
                aria-label={t('mediaCard.addAs', {
                  title,
                  status: t('status.watching'),
                })}
                className="flex min-h-8 touch-manipulation items-center gap-1 rounded-full bg-[hsl(var(--primary))] px-2 py-1 text-xs text-white hover:opacity-90 disabled:opacity-50"
                title={t('status.watching')}
              >
                <Eye className="h-3 w-3" aria-hidden="true" /> {t('status.watching')}
              </button>
              <button
                type="button"
                onClick={() => handleQuickAdd('completed')}
                disabled={createTracking.isPending}
                aria-label={t('mediaCard.addAs', {
                  title,
                  status: t('status.completed'),
                })}
                className="flex min-h-8 touch-manipulation items-center gap-1 rounded-full bg-green-600 px-2 py-1 text-xs text-white hover:opacity-90 disabled:opacity-50"
                title={t('status.completed')}
              >
                <Plus className="h-3 w-3" aria-hidden="true" /> {t('mediaCard.done')}
              </button>
              <button
                type="button"
                onClick={() => handleQuickAdd('plan_to_watch')}
                disabled={createTracking.isPending}
                aria-label={t('mediaCard.addAs', {
                  title,
                  status: t('status.plan_to_watch'),
                })}
                className="flex min-h-8 touch-manipulation items-center rounded-full bg-blue-600 px-2 py-1 text-xs text-white hover:opacity-90 disabled:opacity-50"
                title={t('status.plan_to_watch')}
              >
                <BookmarkPlus className="h-3 w-3" aria-hidden="true" />
              </button>
            </div>
          </div>
        )}
        {savedStatus && (
          <div className="absolute bottom-0 left-0 right-0 bg-green-600/90 p-2 text-center text-xs text-white font-medium">
            {t('mediaCard.addedAs', { status: t(`status.${savedStatus}`) })}
          </div>
        )}
      </div>
      <div className="p-3">
        <h3 className="font-medium text-sm line-clamp-2 text-[hsl(var(--card-foreground))]">
          <Link to={detailPath} className="hover:text-[hsl(var(--primary))]">
            {title}
          </Link>
        </h3>
        {year && <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1">{year}</p>}
        {createTracking.error && (
          <p className="mt-2 text-xs text-[hsl(var(--destructive))]" role="alert">
            {getApiErrorMessage(createTracking.error, t('mediaCard.addError'))}
          </p>
        )}
      </div>
    </article>
  );
}
