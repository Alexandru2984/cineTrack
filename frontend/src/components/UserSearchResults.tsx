import { Link } from 'react-router';
import { Clock3, LockKeyhole, User, UserMinus, UserPlus } from 'lucide-react';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { useFollow, useUnfollow } from '@/hooks/useSocial';
import { getApiErrorMessage } from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { useT } from '@/hooks/useT';
import type { UserSearchResponse, UserSearchResult } from '@/types';

type Translate = (key: string, params?: Record<string, string | number>) => string;

interface UserSearchResultsProps {
  data?: UserSearchResponse;
  isLoading: boolean;
  isError: boolean;
  page: number;
  onPageChange: (page: number) => void;
}

function relationshipLabel(t: Translate, user: UserSearchResult): string {
  if (user.follow_status === 'accepted') return t('profile.unfollow');
  if (user.follow_status === 'pending') return t('userSearch.cancelRequest');
  return user.is_public ? t('profile.follow') : t('userSearch.request');
}

export function UserSearchResults({
  data,
  isLoading,
  isError,
  page,
  onPageChange,
}: UserSearchResultsProps) {
  const t = useT();
  const currentUser = useAuthStore((state) => state.user);
  const follow = useFollow();
  const unfollow = useUnfollow();
  const mutationError = follow.error ?? unfollow.error;

  if (isLoading) return <LoadingSpinner />;
  if (isError) {
    return (
      <p className="py-8 text-sm text-[hsl(var(--destructive))]" role="alert">
        {t('userSearch.loadError')}
      </p>
    );
  }
  if (!data?.results.length) {
    return <p className="py-8 text-[hsl(var(--muted-foreground))]">{t('userSearch.empty')}</p>;
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
                aria-label={t('userSearch.openProfile', { username: user.username })}
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
                      <LockKeyhole className="h-3.5 w-3.5" aria-hidden="true" /> {t('lists.private')}
                    </span>
                  )}
                </div>
                {user.bio && (
                  <p className="mt-1 line-clamp-1 text-sm text-[hsl(var(--muted-foreground))]">
                    {user.bio}
                  </p>
                )}
                {user.followers_count !== null && (
                  <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">
                    {user.followers_count === 1
                      ? t('userSearch.followerOne')
                      : t('userSearch.followerMany', { count: user.followers_count })}
                  </p>
                )}
              </div>

              {isSelf ? (
                <span className="shrink-0 text-sm text-[hsl(var(--muted-foreground))]">{t('userSearch.you')}</span>
              ) : (
                <button
                  type="button"
                  onClick={() =>
                    removeRelationship
                      ? unfollow.mutate(user.username)
                      : follow.mutate(user.username)
                  }
                  disabled={actionPending}
                  aria-label={`${relationshipLabel(t, user)} ${user.username}`}
                  className={`flex shrink-0 items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium disabled:opacity-50 ${
                    removeRelationship
                      ? 'border border-[hsl(var(--border))] hover:border-[hsl(var(--destructive))] hover:text-[hsl(var(--destructive))]'
                      : 'bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] hover:opacity-90'
                  }`}
                >
                  {user.follow_status === 'accepted' ? (
                    <UserMinus className="h-4 w-4" aria-hidden="true" />
                  ) : user.follow_status === 'pending' ? (
                    <Clock3 className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    <UserPlus className="h-4 w-4" aria-hidden="true" />
                  )}
                  <span className="hidden sm:inline">{relationshipLabel(t, user)}</span>
                </button>
              )}
            </article>
          );
        })}
      </div>

      {mutationError && (
        <p className="mt-3 text-sm text-[hsl(var(--destructive))]" role="alert">
          {getApiErrorMessage(mutationError, t('profile.followError'))}
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
            {t('common.previous')}
          </button>
          <span className="text-sm">{t('userSearch.pageN', { page })}</span>
          <button
            type="button"
            disabled={!data.has_more}
            onClick={() => onPageChange(page + 1)}
            className="rounded-md border border-[hsl(var(--border))] px-4 py-2 text-sm disabled:opacity-50"
          >
            {t('common.next')}
          </button>
        </div>
      )}
    </div>
  );
}
