import { useSearchParams } from 'react-router-dom';
import { useParams } from 'react-router-dom';
import { useEpisodes, useMediaDetail, useSeasons } from '@/hooks/useMedia';
import { useCreateTracking, useMarkEpisodeWatched, useWatchedEpisodes } from '@/hooks/useTracking';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { getPosterUrl, getBackdropUrl, formatDate, formatRuntime } from '@/lib/utils';
import { getApiErrorMessage } from '@/lib/api';
import { Calendar, Check, CheckCircle2, Clock, Plus, Star } from 'lucide-react';
import { useState } from 'react';
import type { Media } from '@/types';

type Genre = NonNullable<Media['genres']>[number];

export default function MediaDetail() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const type = searchParams.get('type') || 'movie';
  const { data: media, isLoading } = useMediaDetail(id!, type);
  const [seasonSelection, setSeasonSelection] = useState<{
    mediaId: string;
    seasonNumber: number;
  } | null>(null);
  const { data: seasons = [] } = useSeasons(type === 'tv' ? id! : '');
  const explicitlySelectedSeason = seasonSelection && seasonSelection.mediaId === id
    ? seasonSelection.seasonNumber
    : null;
  const selectedSeason = explicitlySelectedSeason !== null
    && seasons.some((season) => season.season_number === explicitlySelectedSeason)
      ? explicitlySelectedSeason
      : seasons.find((season) => season.season_number > 0)?.season_number
        ?? seasons[0]?.season_number
        ?? null;
  const { data: episodes = [], isLoading: episodesLoading } = useEpisodes(
    type === 'tv' ? id! : '',
    selectedSeason
  );
  const { data: watchedEpisodes = [] } = useWatchedEpisodes(
    media?.tmdb_id,
    selectedSeason
  );
  const createTracking = useCreateTracking();
  const markEpisodeWatched = useMarkEpisodeWatched();
  const [trackingStatus, setTrackingStatus] = useState('');

  if (isLoading) return <LoadingSpinner />;
  if (!media) return <div className="text-center py-16">Media not found</div>;

  const genres: Genre[] = Array.isArray(media.genres) ? media.genres : [];
  const watchedEpisodeSet = new Set(watchedEpisodes);

  const handleAddToList = (status: string) => {
    createTracking.mutate(
      {
        tmdb_id: media.tmdb_id,
        media_type: media.media_type || type,
        status,
      },
      { onSuccess: () => setTrackingStatus(status) }
    );
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
        <div className={`relative z-10 flex flex-col gap-8 md:flex-row ${backdrop ? '-mt-32' : ''}`}>
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
                  {Number(media.vote_average).toFixed(1)}
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
            {genres.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {genres.map((g) => (
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
            {createTracking.error && (
              <p className="text-sm text-[hsl(var(--destructive))]">
                {getApiErrorMessage(createTracking.error, 'Could not update your list')}
              </p>
            )}

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
        {type === 'tv' && seasons.length > 0 && (
          <section className="mt-10">
            <h2 className="text-2xl font-bold mb-4">Seasons</h2>
            <div className="flex gap-2 overflow-x-auto border-b border-[hsl(var(--border))] pb-3" role="tablist">
              {seasons.map((season) => (
                <button
                  key={season.id}
                  type="button"
                  role="tab"
                  aria-selected={selectedSeason === season.season_number}
                  onClick={() => setSeasonSelection({
                    mediaId: id!,
                    seasonNumber: season.season_number,
                  })}
                  className={`min-h-10 shrink-0 rounded-md px-3 text-sm font-medium transition-colors ${
                    selectedSeason === season.season_number
                      ? 'bg-[hsl(var(--primary))] text-white'
                      : 'border border-[hsl(var(--border))] hover:bg-[hsl(var(--secondary))]'
                  }`}
                >
                  {season.season_number === 0 ? 'Specials' : `Season ${season.season_number}`}
                  {season.episode_count != null && (
                    <span className="ml-2 opacity-70">{season.episode_count}</span>
                  )}
                </button>
              ))}
            </div>

            <div className="mt-5">
              {episodesLoading ? (
                <LoadingSpinner />
              ) : episodes.length === 0 ? (
                <p className="py-8 text-[hsl(var(--muted-foreground))]">No episodes available</p>
              ) : (
                <div className="divide-y divide-[hsl(var(--border))]">
                  {episodes.map((episode) => {
                    const watched = watchedEpisodeSet.has(episode.episode_number);
                    return (
                      <div key={episode.id} className="flex min-h-24 items-start gap-3 py-4 sm:gap-4">
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[hsl(var(--secondary))] text-sm font-semibold">
                          {episode.episode_number}
                        </div>
                        <div className="min-w-0 flex-1">
                          <h3 className="font-medium">{episode.name || `Episode ${episode.episode_number}`}</h3>
                          <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-[hsl(var(--muted-foreground))]">
                            {episode.air_date && <span>{formatDate(episode.air_date)}</span>}
                            {episode.runtime_minutes != null && <span>{formatRuntime(episode.runtime_minutes)}</span>}
                          </div>
                          {episode.overview && (
                            <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-[hsl(var(--muted-foreground))]">
                              {episode.overview}
                            </p>
                          )}
                        </div>
                        <button
                          type="button"
                          title={watched ? 'Watched' : 'Mark watched'}
                          disabled={watched || markEpisodeWatched.isPending}
                          onClick={() => markEpisodeWatched.mutate({
                            tmdbId: media.tmdb_id,
                            seasonNumber: selectedSeason!,
                            episodeNumber: episode.episode_number,
                          })}
                          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md border transition-colors sm:w-32 sm:gap-2 ${
                            watched
                              ? 'border-emerald-600 text-emerald-600'
                              : 'border-[hsl(var(--border))] hover:border-[hsl(var(--primary))] hover:text-[hsl(var(--primary))]'
                          } disabled:cursor-default disabled:opacity-70`}
                        >
                          {watched ? <CheckCircle2 className="h-4 w-4" /> : <Check className="h-4 w-4" />}
                          <span className="hidden text-sm sm:inline">{watched ? 'Watched' : 'Mark watched'}</span>
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
              {markEpisodeWatched.error && (
                <p className="mt-3 text-sm text-[hsl(var(--destructive))]">
                  {getApiErrorMessage(markEpisodeWatched.error, 'Could not mark this episode')}
                </p>
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
