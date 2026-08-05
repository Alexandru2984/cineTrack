import { Loader2, UserRound, UsersRound, X } from 'lucide-react';
import { useEffect, useId, useRef } from 'react';
import { Link } from 'react-router';

import { useUserConnections, type UserConnectionKind } from '@/hooks/useSocial';
import { useT } from '@/hooks/useT';
import { getApiErrorMessage } from '@/lib/api';

export function ConnectionsDialog({
  username,
  kind,
  onClose,
}: {
  username: string;
  kind: UserConnectionKind;
  onClose: () => void;
}) {
  const t = useT();
  const titleId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  const connections = useUserConnections(username, kind);
  const users = connections.data?.pages.flat() ?? [];

  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.style.overflow = 'hidden';
    const focusableSelector =
      'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusableElements = () =>
      Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? []);
    focusableElements()[0]?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const elements = focusableElements();
      if (elements.length === 0) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (!dialogRef.current?.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
      previouslyFocused?.focus();
    };
  }, []);

  const title = t(
    kind === 'followers' ? 'profile.followersTitle' : 'profile.followingTitle',
    { username },
  );

  return (
    <div
      className="fixed inset-0 z-[80] flex items-end justify-center bg-black/65 p-0 sm:items-center sm:p-4"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="flex max-h-[calc(100dvh-env(safe-area-inset-top))] w-full flex-col rounded-t-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] shadow-2xl sm:max-w-lg sm:rounded-xl"
      >
        <div className="flex items-center gap-4 border-b border-[hsl(var(--border))] p-5">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="break-words text-xl font-semibold">
              {title}
            </h2>
          </div>
          <button
            type="button"
            aria-label={t('profile.closeConnections')}
            onClick={onClose}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-[hsl(var(--border))]"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        <div className="min-h-48 overflow-y-auto p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
          {connections.isLoading ? (
            <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-[hsl(var(--muted-foreground))]">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              {t('common.loading')}
            </div>
          ) : connections.isError ? (
            <div className="flex min-h-48 flex-col items-center justify-center gap-3 text-center">
              <p className="text-sm text-[hsl(var(--destructive))]" role="alert">
                {getApiErrorMessage(connections.error, t('profile.connectionsLoadError'))}
              </p>
              <button
                type="button"
                onClick={() => void connections.refetch()}
                className="h-10 rounded-md border border-[hsl(var(--border))] px-4 text-sm font-medium"
              >
                {t('common.tryAgain')}
              </button>
            </div>
          ) : users.length > 0 ? (
            <div className="divide-y divide-[hsl(var(--border))]">
              {users.map((user) => (
                <Link
                  key={user.id}
                  to={`/profile/${encodeURIComponent(user.username)}`}
                  onClick={onClose}
                  className="flex min-h-16 items-center gap-3 rounded-md px-2 py-3 transition-colors hover:bg-[hsl(var(--accent))]"
                >
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[hsl(var(--muted))]">
                    {user.avatar_url ? (
                      <img
                        src={user.avatar_url}
                        alt=""
                        loading="lazy"
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <UserRound
                        className="h-5 w-5 text-[hsl(var(--muted-foreground))]"
                        aria-hidden="true"
                      />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block break-all text-sm font-medium">{user.username}</span>
                    {user.bio ? (
                      <span className="mt-0.5 block truncate text-xs text-[hsl(var(--muted-foreground))]">
                        {user.bio}
                      </span>
                    ) : null}
                  </span>
                </Link>
              ))}
            </div>
          ) : (
            <div className="flex min-h-48 flex-col items-center justify-center gap-3 px-5 text-center">
              <UsersRound className="h-8 w-8 text-[hsl(var(--muted-foreground))]" aria-hidden="true" />
              <p className="text-sm text-[hsl(var(--muted-foreground))]">
                {t(kind === 'followers' ? 'profile.followersEmpty' : 'profile.followingEmpty')}
              </p>
            </div>
          )}

          {connections.hasNextPage ? (
            <button
              type="button"
              disabled={connections.isFetchingNextPage}
              onClick={() => void connections.fetchNextPage()}
              className="mt-3 flex h-10 items-center gap-2 rounded-md border border-[hsl(var(--border))] px-3 text-sm font-medium disabled:opacity-50"
            >
              {connections.isFetchingNextPage ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : null}
              {t('common.loadMore')}
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}
