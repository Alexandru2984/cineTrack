import { Loader2, ShieldOff, UserRoundX } from 'lucide-react';

import { useBlockedUsers, useUnblockUser } from '@/hooks/useSocial';
import { useT } from '@/hooks/useT';
import { getApiErrorMessage } from '@/lib/api';

export function BlockedUsersCard() {
  const t = useT();
  const blocked = useBlockedUsers();
  const unblock = useUnblockUser();
  const users = blocked.data?.pages.flat() ?? [];

  return (
    <section className="rounded-lg border border-[hsl(var(--border))] p-4 sm:p-6">
      <div className="flex items-start gap-3">
        <span className="rounded-full bg-[hsl(var(--muted))] p-2">
          <ShieldOff className="h-5 w-5 text-[hsl(var(--muted-foreground))]" aria-hidden="true" />
        </span>
        <div>
          <h2 className="font-semibold">{t('safety.blockedTitle')}</h2>
          <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
            {t('safety.blockedHint')}
          </p>
        </div>
      </div>

      {blocked.isLoading ? (
        <div className="mt-5 flex items-center gap-2 text-sm text-[hsl(var(--muted-foreground))]">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          {t('common.loading')}
        </div>
      ) : blocked.isError ? (
        <div className="mt-5">
          <p className="text-sm text-[hsl(var(--destructive))]" role="alert">
            {getApiErrorMessage(blocked.error, t('safety.blockedLoadError'))}
          </p>
          <button
            type="button"
            onClick={() => void blocked.refetch()}
            className="mt-3 h-10 rounded-md border border-[hsl(var(--border))] px-3 text-sm font-medium"
          >
            {t('common.tryAgain')}
          </button>
        </div>
      ) : users.length === 0 ? (
        <p className="mt-5 text-sm text-[hsl(var(--muted-foreground))]">
          {t('safety.blockedEmpty')}
        </p>
      ) : (
        <div className="mt-5 divide-y divide-[hsl(var(--border))] border-y border-[hsl(var(--border))]">
          {users.map((user) => (
            <div key={user.id} className="flex min-h-16 items-center gap-3 py-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[hsl(var(--muted))]">
                {user.avatar_url ? (
                  <img
                    src={user.avatar_url}
                    alt=""
                    loading="lazy"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <UserRoundX
                    className="h-5 w-5 text-[hsl(var(--muted-foreground))]"
                    aria-hidden="true"
                  />
                )}
              </span>
              <span className="min-w-0 flex-1 break-all text-sm font-medium">
                {user.username}
              </span>
              <button
                type="button"
                disabled={unblock.isPending}
                onClick={() => unblock.mutate(user.username)}
                className="h-10 shrink-0 rounded-md border border-[hsl(var(--border))] px-3 text-sm font-medium disabled:opacity-50"
              >
                {t('safety.unblock')}
              </button>
            </div>
          ))}
        </div>
      )}

      {blocked.hasNextPage ? (
        <button
          type="button"
          disabled={blocked.isFetchingNextPage}
          onClick={() => void blocked.fetchNextPage()}
          className="mt-4 flex h-10 items-center gap-2 rounded-md border border-[hsl(var(--border))] px-3 text-sm font-medium disabled:opacity-50"
        >
          {blocked.isFetchingNextPage ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : null}
          {t('common.loadMore')}
        </button>
      ) : null}

      {unblock.error ? (
        <p className="mt-3 text-sm text-[hsl(var(--destructive))]" role="alert">
          {getApiErrorMessage(unblock.error, t('safety.unblockError'))}
        </p>
      ) : null}
    </section>
  );
}
