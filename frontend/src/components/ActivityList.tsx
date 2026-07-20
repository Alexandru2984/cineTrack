import { Link } from 'react-router-dom';
import { User } from 'lucide-react';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { formatDateTime, getPosterUrl } from '@/lib/utils';
import type { ActivityItem } from '@/types';

interface ActivityListProps {
  items?: ActivityItem[];
  isLoading?: boolean;
  isError?: boolean;
  showUser?: boolean;
}

function episodeLabel(item: ActivityItem): string | null {
  if (item.season_number === null || item.episode_number === null) return null;

  const position = `S${item.season_number} E${item.episode_number}`;
  return item.episode_name ? `${position} · ${item.episode_name}` : position;
}

export function ActivityList({
  items,
  isLoading = false,
  isError = false,
  showUser = true,
}: ActivityListProps) {
  if (isLoading) return <LoadingSpinner />;

  if (isError) {
    return (
      <p className="py-6 text-sm text-[hsl(var(--destructive))]" role="alert">
        Activity could not be loaded
      </p>
    );
  }

  if (!items?.length) {
    return <p className="py-6 text-[hsl(var(--muted-foreground))]">No recent activity</p>;
  }

  return (
    <div className="divide-y divide-[hsl(var(--border))] border-y border-[hsl(var(--border))]">
      {items.map((item) => {
        const episode = episodeLabel(item);
        const mediaUrl = `/media/${item.tmdb_id}?type=${encodeURIComponent(item.media_type)}`;

        return (
          <article key={item.id} className="flex min-w-0 gap-3 py-4">
            <Link
              to={mediaUrl}
              className="h-[4.5rem] w-12 shrink-0 overflow-hidden rounded bg-[hsl(var(--muted))]"
              aria-label={`Open ${item.media_title}`}
            >
              <img
                src={getPosterUrl(item.poster_path, 'w92')}
                alt={`${item.media_title} poster`}
                className="h-full w-full object-cover"
                loading="lazy"
                decoding="async"
              />
            </Link>

            <div className="min-w-0 flex-1 self-center">
              <div className="flex min-w-0 items-center gap-2 text-sm">
                {showUser && (
                  <Link
                    to={`/profile/${encodeURIComponent(item.username)}`}
                    className="flex min-w-0 shrink items-center gap-2 font-semibold hover:text-[hsl(var(--primary))]"
                  >
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[hsl(var(--muted))]">
                      {item.avatar_url ? (
                        <img
                          src={item.avatar_url}
                          alt=""
                          className="h-full w-full object-cover"
                          loading="lazy"
                          decoding="async"
                        />
                      ) : (
                        <User className="h-4 w-4 text-[hsl(var(--muted-foreground))]" aria-hidden="true" />
                      )}
                    </span>
                    <span className="truncate">{item.username}</span>
                  </Link>
                )}
                <span className="shrink-0 text-[hsl(var(--muted-foreground))]">
                  {showUser ? item.action : `${item.action.charAt(0).toUpperCase()}${item.action.slice(1)}`}
                </span>
              </div>

              <Link
                to={mediaUrl}
                className="mt-1 block truncate font-medium hover:text-[hsl(var(--primary))]"
              >
                {item.media_title}
              </Link>
              {episode && (
                <p className="mt-0.5 truncate text-sm text-[hsl(var(--muted-foreground))]">
                  {/* Older rows predate the episode link, and a title watch has
                      no episode at all, so fall back to plain text. */}
                  {item.episode_id ? (
                    <Link
                      to={`/episodes/${item.episode_id}`}
                      className="hover:text-[hsl(var(--foreground))] hover:underline"
                    >
                      {episode}
                    </Link>
                  ) : (
                    episode
                  )}
                </p>
              )}
              <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-[hsl(var(--muted-foreground))]">
                <span>{item.media_type === 'tv' ? 'TV show' : 'Movie'}</span>
                <span aria-hidden="true">·</span>
                <time dateTime={item.timestamp}>{formatDateTime(item.timestamp)}</time>
              </p>
            </div>
          </article>
        );
      })}
    </div>
  );
}
