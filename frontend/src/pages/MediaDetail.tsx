import { useSearchParams } from 'react-router-dom';
import { useParams } from 'react-router-dom';
import { useEpisodes, useMediaDetail, useSeasons } from '@/hooks/useMedia';
import {
  useCreateTracking,
  useMarkEpisodeWatched,
  useMarkEpisodesWatchedThrough,
  useMarkSeasonWatched,
  useShowWatchProgress,
  useWatchedEpisodes,
} from '@/hooks/useTracking';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { AddToListDialog } from '@/components/AddToListDialog';
import { getPosterUrl, getBackdropUrl, formatDate, formatRuntime } from '@/lib/utils';
import { getApiErrorMessage } from '@/lib/api';
import {
  Calendar,
  Check,
  CheckCheck,
  CheckCircle2,
  Clock,
  Loader2,
  ListPlus,
  Plus,
  Star,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Episode, Media, Season, SeasonWatchProgress } from '@/types';

type Genre = NonNullable<Media['genres']>[number];
type WatchConfirmation =
  | {
      kind: 'episode';
      episode: Episode;
      previousUnwatchedCount: number;
    }
  | {
      kind: 'season';
      season: Season;
      unwatchedCount: number;
    };

function episodeCode(seasonNumber: number, episodeNumber: number): string {
  return `S${String(seasonNumber).padStart(2, '0')}E${String(episodeNumber).padStart(2, '0')}`;
}

function localDateKey(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

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
  const { data: showWatchProgress = [] } = useShowWatchProgress(media?.tmdb_id);
  const createTracking = useCreateTracking();
  const markEpisodeWatched = useMarkEpisodeWatched();
  const markSeasonWatched = useMarkSeasonWatched();
  const markEpisodesWatchedThrough = useMarkEpisodesWatchedThrough();
  const [trackingStatus, setTrackingStatus] = useState('');
  const [watchConfirmation, setWatchConfirmation] = useState<WatchConfirmation | null>(null);
  const [listPickerOpen, setListPickerOpen] = useState(false);
  const [listFeedback, setListFeedback] = useState<string | null>(null);

  if (isLoading) return <LoadingSpinner />;
  if (!media) return <div className="text-center py-16">Media not found</div>;

  const genres: Genre[] = Array.isArray(media.genres) ? media.genres : [];
  const watchedEpisodeSet = new Set(watchedEpisodes);
  const progressBySeason = new Map<number, SeasonWatchProgress>(
    showWatchProgress.map((progress) => [progress.season_number, progress]),
  );
  const selectedSeasonData = seasons.find(
    (season) => season.season_number === selectedSeason,
  );
  const watchableEpisodes = episodes.filter(
    (episode) => episode.air_date === null || episode.air_date <= localDateKey(),
  );
  const selectedSeasonUnwatchedCount = watchableEpisodes.filter(
    (episode) => !watchedEpisodeSet.has(episode.episode_number),
  ).length;
  const bulkWatchPending = markSeasonWatched.isPending || markEpisodesWatchedThrough.isPending;
  const watchError = markEpisodeWatched.error
    ?? markSeasonWatched.error
    ?? markEpisodesWatchedThrough.error;

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

  const previousUnwatchedCount = (episode: Episode): number => {
    const earlierSeasonCount = seasons
      .filter(
        (season) =>
          season.season_number > 0
          && selectedSeason !== null
          && season.season_number < selectedSeason,
      )
      .reduce((total, season) => {
        const progress = progressBySeason.get(season.season_number);
        const expected = progress?.episode_count
          ?? season.episode_count
          ?? progress?.available_episode_count
          ?? 0;
        return total + Math.max(0, expected - (progress?.watched_count ?? 0));
      }, 0);
    const earlierCurrentSeasonCount = episodes.filter(
      (candidate) =>
        candidate.episode_number < episode.episode_number
        && !watchedEpisodeSet.has(candidate.episode_number),
    ).length;
    return earlierSeasonCount + earlierCurrentSeasonCount;
  };

  const handleEpisodeWatch = (episode: Episode) => {
    const previousCount = previousUnwatchedCount(episode);
    if (previousCount > 0) {
      setWatchConfirmation({
        kind: 'episode',
        episode,
        previousUnwatchedCount: previousCount,
      });
      return;
    }
    markEpisodeWatched.mutate({
      tmdbId: media.tmdb_id,
      seasonNumber: selectedSeason!,
      episodeNumber: episode.episode_number,
    });
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
              <button
                type="button"
                onClick={() => {
                  setListFeedback(null);
                  setListPickerOpen(true);
                }}
                className="flex items-center gap-2 rounded-md border border-[hsl(var(--border))] px-4 py-2 text-sm font-medium transition-colors hover:bg-[hsl(var(--secondary))]"
              >
                <ListPlus className="h-4 w-4" aria-hidden="true" />
                Custom list
              </button>
            </div>
            {listFeedback ? (
              <p className="text-sm text-emerald-600 dark:text-emerald-400" role="status">
                {listFeedback}
              </p>
            ) : null}
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
              {seasons.map((season) => {
                const progress = progressBySeason.get(season.season_number);
                const total = progress?.episode_count ?? season.episode_count;
                return (
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
                    {total != null && (
                      <span className="ml-2 opacity-70">
                        {progress ? `${progress.watched_count}/${total}` : total}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            <div className="mt-5">
              {episodesLoading ? (
                <LoadingSpinner />
              ) : episodes.length === 0 ? (
                <p className="py-8 text-[hsl(var(--muted-foreground))]">No episodes available</p>
              ) : (
                <>
                  <div className="mb-2 flex min-h-10 flex-wrap items-center justify-between gap-2 border-b border-[hsl(var(--border))] pb-2">
                    <p className="text-sm text-[hsl(var(--muted-foreground))]">
                      {watchedEpisodeSet.size} of {episodes.length} watched
                    </p>
                    <button
                      type="button"
                      disabled={selectedSeasonUnwatchedCount === 0 || bulkWatchPending}
                      onClick={() => {
                        if (selectedSeasonData) {
                          setWatchConfirmation({
                            kind: 'season',
                            season: selectedSeasonData,
                            unwatchedCount: selectedSeasonUnwatchedCount,
                          });
                        }
                      }}
                      className="flex h-9 items-center gap-2 rounded-md border border-[hsl(var(--border))] px-3 text-sm font-medium hover:border-emerald-600 hover:text-emerald-600 disabled:cursor-default disabled:opacity-60"
                    >
                      {bulkWatchPending
                        ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                        : selectedSeasonUnwatchedCount === 0
                          ? <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                          : <CheckCheck className="h-4 w-4" aria-hidden="true" />}
                      {selectedSeasonUnwatchedCount === 0 ? 'Season watched' : 'Mark season watched'}
                    </button>
                  </div>
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
                            disabled={watched || markEpisodeWatched.isPending || bulkWatchPending}
                            onClick={() => handleEpisodeWatch(episode)}
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
                </>
              )}
              {watchError && (
                <p className="mt-3 text-sm text-[hsl(var(--destructive))]">
                  {getApiErrorMessage(watchError, 'Could not update watched episodes')}
                </p>
              )}
            </div>
          </section>
        )}
      </div>
      {watchConfirmation && selectedSeason !== null && (
        <WatchConfirmationDialog
          confirmation={watchConfirmation}
          seasonNumber={selectedSeason}
          pending={markEpisodeWatched.isPending || bulkWatchPending}
          onClose={() => setWatchConfirmation(null)}
          onOnlyEpisode={() => {
            if (watchConfirmation.kind !== 'episode') return;
            markEpisodeWatched.mutate(
              {
                tmdbId: media.tmdb_id,
                seasonNumber: selectedSeason,
                episodeNumber: watchConfirmation.episode.episode_number,
              },
              { onSuccess: () => setWatchConfirmation(null) },
            );
          }}
          onEpisodeAndPrevious={() => {
            if (watchConfirmation.kind !== 'episode') return;
            markEpisodesWatchedThrough.mutate(
              {
                tmdbId: media.tmdb_id,
                seasonNumber: selectedSeason,
                episodeNumber: watchConfirmation.episode.episode_number,
              },
              { onSuccess: () => setWatchConfirmation(null) },
            );
          }}
          onSeason={() => {
            if (watchConfirmation.kind !== 'season') return;
            markSeasonWatched.mutate(
              {
                tmdbId: media.tmdb_id,
                seasonNumber: watchConfirmation.season.season_number,
              },
              { onSuccess: () => setWatchConfirmation(null) },
            );
          }}
        />
      )}
      {listPickerOpen ? (
        <AddToListDialog
          mediaId={media.id}
          title={media.title}
          onClose={() => setListPickerOpen(false)}
          onAdded={(listName) => {
            setListFeedback(`Added to ${listName}.`);
            setListPickerOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

function WatchConfirmationDialog({
  confirmation,
  seasonNumber,
  pending,
  onClose,
  onOnlyEpisode,
  onEpisodeAndPrevious,
  onSeason,
}: {
  confirmation: WatchConfirmation;
  seasonNumber: number;
  pending: boolean;
  onClose: () => void;
  onOnlyEpisode: () => void;
  onEpisodeAndPrevious: () => void;
  onSeason: () => void;
}) {
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !pending) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, pending]);

  const episodeLabel = confirmation.kind === 'episode'
    ? episodeCode(seasonNumber, confirmation.episode.episode_number)
    : null;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="watch-confirmation-title"
        className="w-full max-w-md rounded-t-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-5 shadow-2xl sm:rounded-lg"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="watch-confirmation-title" className="text-lg font-semibold">
              {confirmation.kind === 'episode'
                ? `Mark ${episodeLabel} watched?`
                : `Mark ${confirmation.season.name || `Season ${confirmation.season.season_number}`} watched?`}
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-[hsl(var(--muted-foreground))]">
              {confirmation.kind === 'episode'
                ? `${confirmation.previousUnwatchedCount} earlier unwatched episode${confirmation.previousUnwatchedCount === 1 ? '' : 's'} can be added at the same time.`
                : `${confirmation.unwatchedCount} available episode${confirmation.unwatchedCount === 1 ? '' : 's'} will be added to your history.`}
            </p>
          </div>
          <button
            type="button"
            title="Close"
            aria-label="Close"
            disabled={pending}
            onClick={onClose}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md hover:bg-[hsl(var(--accent))] disabled:opacity-50"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            disabled={pending}
            onClick={onClose}
            className="h-10 rounded-md border border-[hsl(var(--border))] px-4 text-sm font-medium hover:bg-[hsl(var(--accent))] disabled:opacity-50"
          >
            Cancel
          </button>
          {confirmation.kind === 'episode' ? (
            <>
              <button
                type="button"
                autoFocus
                disabled={pending}
                onClick={onOnlyEpisode}
                className="h-10 rounded-md border border-[hsl(var(--border))] px-4 text-sm font-medium hover:bg-[hsl(var(--accent))] disabled:opacity-50"
              >
                Only this episode
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={onEpisodeAndPrevious}
                className="flex h-10 items-center justify-center gap-2 rounded-md bg-emerald-600 px-4 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                This and previous
              </button>
            </>
          ) : (
            <button
              type="button"
              autoFocus
              disabled={pending}
              onClick={onSeason}
              className="flex h-10 items-center justify-center gap-2 rounded-md bg-emerald-600 px-4 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              Mark season
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
