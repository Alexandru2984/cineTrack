import { Link } from 'react-router-dom';
import { Clock3, LockKeyhole, User, UserMinus, UserPlus } from 'lucide-react';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { useFollow, useUnfollow } from '@/hooks/useSocial';
import { getApiErrorMessage } from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import type { UserSearchResponse, UserSearchResult } from '@/types';

interface UserSearchResultsProps {
  data?: UserSearchResponse;
  isLoading: boolean;
  isError: boolean;
  page: number;
  onPageChange: (page: number) => void;
}

function relationshipLabel(user: UserSearchResult): string {
  if (user.follow_status === 'accepted') return 'Unfollow';
  if (user.follow_status === 'pending') return 'Cancel request';
  return user.is_public ? 'Follow' : 'Request';
}

export function UserSearchResults({
  data,
  isLoading,
  isError,
  page,
  onPageChange,
}: UserSearchResultsProps) {
  const currentUser = useAuthStore((state) => state.user);
  const follow = useFollow();
  const unfollow = useUnfollow();
  const mutationError = follow.error ?? unfollow.error;

  if (isLoading) return <LoadingSpinner />;
  if (isError) {
    return (
      <p className="py-8 text-sm text-[hsl(var(--destructive))]" role="alert">
        People search could not be loaded
      </p>
    );
  }
  if (!data?.results.length) {
    return <p className="py-8 text-[hsl(var(--muted-foreground))]">No people found</p>;
  }

  return (
    <div>
      <div className="divide-y divide-[hsl(var(--border))] border-y border-[hsl(var(--border))]">
        {data.results.map((user) => {
          const isSelf = currentUser?.id === user.id;
          const removeRelationship = user.follow_status !== null;
          const actionPending =
            (follow.isPending && follow.variables === user.username)
            || (unfollow.isPending && unfollow.variables === user.username);

          return (
            <article key={user.id} className="flex min-w-0 items-center gap-3 py-4">
              <Link
                to={`/profile/${encodeURIComponent(user.username)}`}
                className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[hsl(var(--muted))]"
                aria-label={`Open ${user.username}'s profile`}
              >
                {user.avatar_url ? (
                  <img
                    src={user.avatar_url}
                    alt=""
                    className="h-full w-full object-cover"
                    loading="lazy"
                    decoding="async"
                  />
                ) : (
                  <User className="h-6 w-6 text-[hsl(var(--muted-foreground))]" aria-hidden="true" />
                )}
              </Link>

              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <Link
                    to={`/profile/${encodeURIComponent(user.username)}`}
                    className="max-w-full break-all font-semibold hover:text-[hsl(var(--primary))]"
                  >
                    {user.username}
                  </Link>
                  {!user.is_public && (
                    <span className="flex items-center gap-1 text-xs text-[hsl(var(--muted-foreground))]">
                      <LockKeyhole className="h-3.5 w-3.5" aria-hidden="true" /> Private
                    </span>
                  )}
                </div>
                {user.bio && (
                  <p className="mt-1 line-clamp-1 text-sm text-[hsl(var(--muted-foreground))]">
                    {user.bio}
                  </p>
                )}
                <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">
                  {user.followers_count} {user.followers_count === 1 ? 'follower' : 'followers'}
                </p>
              </div>

              {isSelf ? (
                <span className="shrink-0 text-sm text-[hsl(var(--muted-foreground))]">You</span>
              ) : (
                <button
                  type="button"
                  onClick={() =>
                    removeRelationship
                      ? unfollow.mutate(user.username)
                      : follow.mutate(user.username)
                  }
                  disabled={actionPending}
                  aria-label={`${relationshipLabel(user)} ${user.username}`}
                  className={`flex shrink-0 items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium disabled:opacity-50 ${
                    removeRelationship
                      ? 'border border-[hsl(var(--border))] hover:border-[hsl(var(--destructive))] hover:text-[hsl(var(--destructive))]'
                      : 'bg-[hsl(var(--primary))] text-white hover:opacity-90'
                  }`}
                >
                  {user.follow_status === 'accepted' ? (
                    <UserMinus className="h-4 w-4" aria-hidden="true" />
                  ) : user.follow_status === 'pending' ? (
                    <Clock3 className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    <UserPlus className="h-4 w-4" aria-hidden="true" />
                  )}
                  <span className="hidden sm:inline">{relationshipLabel(user)}</span>
                </button>
              )}
            </article>
          );
        })}
      </div>

      {mutationError && (
        <p className="mt-3 text-sm text-[hsl(var(--destructive))]" role="alert">
          {getApiErrorMessage(mutationError, 'Could not update follow status')}
        </p>
      )}

      {(page > 1 || data.has_more) && (
        <div className="flex items-center justify-center gap-4 pt-6">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => onPageChange(page - 1)}
            className="rounded-md border border-[hsl(var(--border))] px-4 py-2 text-sm disabled:opacity-50"
          >
            Previous
          </button>
          <span className="text-sm">Page {page}</span>
          <button
            type="button"
            disabled={!data.has_more}
            onClick={() => onPageChange(page + 1)}
            className="rounded-md border border-[hsl(var(--border))] px-4 py-2 text-sm disabled:opacity-50"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
