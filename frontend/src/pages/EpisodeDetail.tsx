import {
  AlertCircle,
  Bookmark,
  BookmarkCheck,
  Check,
  CheckCircle2,
  Clock3,
  Loader2,
  Tv,
} from 'lucide-react';
import { Link, useParams } from 'react-router-dom';

import { EpisodeReactions } from '@/components/EpisodeReactions';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import {
  useMarkCalendarEpisodeWatched,
  useSetEpisodePlanned,
} from '@/hooks/useCalendar';
import { useEpisodeDetail, useSetEpisodeReaction } from '@/hooks/useMedia';
import { usePageTitle } from '@/hooks/usePageTitle';
import { getApiErrorMessage } from '@/lib/api';
import { formatDate, formatDateTime, formatRuntime, getPosterUrl } from '@/lib/utils';

function episodeCode(season: number, episode: number) {
  return `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
}

export default function EpisodeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const episode = useEpisodeDetail(id);
  const setReaction = useSetEpisodeReaction(id);
  const setPlanned = useSetEpisodePlanned();
  const markWatched = useMarkCalendarEpisodeWatched();
  const item = episode.data;
  usePageTitle(
    item ? `${episodeCode(item.season_number, item.episode_number)} ${item.title}` : undefined,
  );

  if (episode.isLoading) return <LoadingSpinner />;
  if (episode.isError || !item) {
    return (
      <div className="mx-auto flex min-h-64 max-w-3xl items-center justify-between gap-4 px-4 py-10">
        <div className="flex items-center gap-2 text-sm text-[hsl(var(--destructive))]">
          <AlertCircle className="h-5 w-5" aria-hidden="true" />
          {getApiErrorMessage(episode.error, 'Episode not found')}
        </div>
        <button
          type="button"
          onClick={() => void episode.refetch()}
          className="h-10 rounded-md border border-[hsl(var(--border))] px-3 text-sm font-medium"
        >
          Retry
        </button>
      </div>
    );
  }

  const code = episodeCode(item.season_number, item.episode_number);
  const episodeName = item.episode_name || `Episode ${item.episode_number}`;
  const actionError = setPlanned.error ?? markWatched.error;
  const canManage = item.tracking_status !== null && item.tracking_status !== 'dropped';
  const artwork = getPosterUrl(
    item.still_path ?? item.poster_path,
    item.still_path ? 'w780' : 'w342',
  );

  return (
    <article className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-10">
      <header className="grid gap-6 border-b border-[hsl(var(--border))] pb-7 md:grid-cols-[minmax(18rem,2fr)_minmax(16rem,1fr)] md:items-start">
        <div className="aspect-video overflow-hidden rounded-md bg-[hsl(var(--muted))]">
          <img src={artwork} alt="" className="h-full w-full object-cover" />
        </div>
        <div className="min-w-0">
          <Link
            to={`/media/${item.tmdb_id}?type=tv`}
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-[hsl(var(--primary))] hover:underline"
          >
            <Tv className="h-4 w-4" aria-hidden="true" />
            {item.title}
          </Link>
          <p className="mt-4 font-mono text-sm text-[hsl(var(--muted-foreground))]">{code}</p>
          <h1 className="mt-1 text-2xl font-bold sm:text-3xl">{episodeName}</h1>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-sm text-[hsl(var(--muted-foreground))]">
            <span>{item.season_name || `Season ${item.season_number}`}</span>
            <span>{item.air_date ? formatDate(item.air_date) : 'Air date TBA'}</span>
            {item.runtime_minutes != null && (
              <span className="inline-flex items-center gap-1">
                <Clock3 className="h-4 w-4" aria-hidden="true" />
                {formatRuntime(item.runtime_minutes)}
              </span>
            )}
          </div>

          <div className="mt-6 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={!canManage || setPlanned.isPending || item.is_watched}
              onClick={() =>
                setPlanned.mutate({ episodeId: item.episode_id, planned: !item.is_planned })
              }
              className="inline-flex h-11 items-center gap-2 rounded-md border border-[hsl(var(--border))] px-4 text-sm font-semibold disabled:opacity-50"
            >
              {setPlanned.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : item.is_planned ? (
                <BookmarkCheck className="h-4 w-4" aria-hidden="true" />
              ) : (
                <Bookmark className="h-4 w-4" aria-hidden="true" />
              )}
              {item.is_planned ? 'Remove from Watch next' : 'Watch next'}
            </button>
            {item.is_available && (
              <button
                type="button"
                disabled={!canManage || item.is_watched || markWatched.isPending}
                onClick={() => markWatched.mutate(item.episode_id)}
                className="inline-flex h-11 items-center gap-2 rounded-md bg-emerald-600 px-4 text-sm font-semibold text-white disabled:opacity-55"
              >
                {markWatched.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : item.is_watched ? (
                  <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <Check className="h-4 w-4" aria-hidden="true" />
                )}
                {item.is_watched ? 'Watched' : 'Mark watched'}
              </button>
            )}
          </div>
          {!canManage && (
            <p className="mt-3 text-xs text-[hsl(var(--muted-foreground))]">
              Add the series to your library to manage this episode.
            </p>
          )}
          {!item.is_available && (
            <p className="mt-3 text-xs text-[hsl(var(--muted-foreground))]">
              This episode can be marked watched after its release date.
            </p>
          )}
        </div>
      </header>

      {actionError && (
        <div
          role="alert"
          className="mt-5 flex items-center gap-2 text-sm text-[hsl(var(--destructive))]"
        >
          <AlertCircle className="h-4 w-4" aria-hidden="true" />
          {getApiErrorMessage(actionError, 'Could not update this episode')}
        </div>
      )}

      <section className="py-7" aria-labelledby="episode-overview">
        <h2 id="episode-overview" className="text-lg font-semibold">Overview</h2>
        <p className="mt-3 max-w-3xl text-sm leading-7 text-[hsl(var(--muted-foreground))]">
          {item.overview || 'No overview is available for this episode.'}
        </p>
        {item.last_watched_at && (
          <p className="mt-5 text-xs text-[hsl(var(--muted-foreground))]">
            Watched {item.watch_count} {item.watch_count === 1 ? 'time' : 'times'} · Last on{' '}
            {formatDateTime(item.last_watched_at)}
          </p>
        )}
      </section>

      <EpisodeReactions
        reactions={item.reactions}
        myReaction={item.my_reaction}
        canReact={item.is_watched}
        pending={setReaction.isPending}
        onSelect={(reaction) => setReaction.mutate(reaction)}
      />
    </article>
  );
}
