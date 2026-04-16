import { useSearchParams } from 'react-router-dom';
import { useParams } from 'react-router-dom';
import { useMediaDetail, useSeasons } from '@/hooks/useMedia';
import { useCreateTracking } from '@/hooks/useTracking';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { getPosterUrl, getBackdropUrl, formatDate, formatRuntime } from '@/lib/utils';
import { Star, Plus, Calendar, Clock } from 'lucide-react';
import { useState } from 'react';

export default function MediaDetail() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const type = searchParams.get('type') || 'movie';
  const { data: media, isLoading } = useMediaDetail(id!, type);
  const { data: seasons } = useSeasons(type === 'tv' ? id! : '');
  const createTracking = useCreateTracking();
  const [trackingStatus, setTrackingStatus] = useState('');

  if (isLoading) return <LoadingSpinner />;
  if (!media) return <div className="text-center py-16">Media not found</div>;

  const handleAddToList = (status: string) => {
    createTracking.mutate({
      tmdb_id: media.tmdb_id,
      media_type: media.media_type || type,
      status,
    });
    setTrackingStatus(status);
  };

  const backdrop = getBackdropUrl(media.backdrop_path);

  return (
    <div>
      {/* Backdrop */}
      {backdrop && (
        <div className="relative h-64 md:h-96 overflow-hidden">
          <img src={backdrop} alt="" className="w-full h-full object-cover" />
          <div className="absolute inset-0 bg-gradient-to-t from-[hsl(var(--background))] to-transparent" />
        </div>
      )}

      <div className="mx-auto max-w-7xl px-4 py-8">
        <div className="flex flex-col md:flex-row gap-8 -mt-32 relative z-10">
          {/* Poster */}
          <div className="shrink-0">
            <img
              src={getPosterUrl(media.poster_path, 'w342')}
              alt={media.title}
              className="w-48 md:w-64 rounded-lg shadow-lg"
            />
          </div>

          {/* Info */}
          <div className="flex-1 space-y-4">
            <h1 className="text-3xl md:text-4xl font-bold">{media.title}</h1>
            {media.original_title && media.original_title !== media.title && (
              <p className="text-[hsl(var(--muted-foreground))] italic">{media.original_title}</p>
            )}

            <div className="flex flex-wrap items-center gap-4 text-sm text-[hsl(var(--muted-foreground))]">
              {media.vote_average != null && (
                <span className="flex items-center gap-1">
                  <Star className="h-4 w-4 fill-yellow-400 text-yellow-400" />
                  {Number(media.vote_average || media.tmdb_vote_average).toFixed(1)}
                </span>
              )}
              {media.release_date && (
                <span className="flex items-center gap-1">
                  <Calendar className="h-4 w-4" />
                  {formatDate(media.release_date)}
                </span>
              )}
              {media.runtime_minutes && (
                <span className="flex items-center gap-1">
                  <Clock className="h-4 w-4" />
                  {formatRuntime(media.runtime_minutes)}
                </span>
              )}
              {media.status && (
                <span className="rounded-full border px-2 py-0.5 text-xs">{media.status}</span>
              )}
            </div>

            {/* Genres */}
            {media.genres && (
              <div className="flex flex-wrap gap-2">
                {(Array.isArray(media.genres) ? media.genres : []).map((g: any) => (
                  <span key={g.id || g.name} className="rounded-full bg-[hsl(var(--secondary))] px-3 py-1 text-xs">
                    {g.name}
                  </span>
                ))}
              </div>
            )}

            {/* Add to list */}
            <div className="flex flex-wrap gap-2 pt-2">
              {['watching', 'plan_to_watch', 'completed'].map((status) => (
                <button
                  key={status}
                  onClick={() => handleAddToList(status)}
                  disabled={createTracking.isPending}
                  className={`flex items-center gap-1 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
                    trackingStatus === status
                      ? 'bg-[hsl(var(--primary))] text-white'
                      : 'border border-[hsl(var(--border))] hover:bg-[hsl(var(--secondary))]'
                  }`}
                >
                  <Plus className="h-4 w-4" />
                  {status === 'watching' ? 'Watching' : status === 'plan_to_watch' ? 'Plan to Watch' : 'Completed'}
                </button>
              ))}
            </div>

            {/* Overview */}
            {media.overview && (
              <div>
                <h2 className="text-lg font-semibold mb-2">Overview</h2>
                <p className="text-[hsl(var(--muted-foreground))] leading-relaxed">{media.overview}</p>
              </div>
            )}
          </div>
        </div>

        {/* Seasons */}
        {type === 'tv' && seasons && Array.isArray(seasons) && seasons.length > 0 && (
          <div className="mt-8">
            <h2 className="text-2xl font-bold mb-4">Seasons</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
              {seasons.map((s: any) => (
                <div key={s.id} className="rounded-lg border border-[hsl(var(--border))] p-4 bg-[hsl(var(--card))]">
                  <p className="font-medium">{s.name || `Season ${s.season_number}`}</p>
                  {s.episode_count && (
                    <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1">{s.episode_count} episodes</p>
                  )}
                  {s.air_date && (
                    <p className="text-xs text-[hsl(var(--muted-foreground))]">{formatDate(s.air_date)}</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
