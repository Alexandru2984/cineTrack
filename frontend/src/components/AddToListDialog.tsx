import { ListPlus, Loader2, Lock, Plus, X } from 'lucide-react';
import { useEffect, useId } from 'react';
import { Link } from 'react-router-dom';

import { useAddListItem, useMyLists } from '@/hooks/useLists';
import { getApiErrorMessage } from '@/lib/api';

export function AddToListDialog({
  mediaId,
  title,
  onClose,
  onAdded,
}: {
  mediaId: string;
  title: string;
  onClose: () => void;
  onAdded: (listName: string) => void;
}) {
  const titleId = useId();
  const lists = useMyLists();
  const addItem = useAddListItem();

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !addItem.isPending) onClose();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [addItem.isPending, onClose]);

  return (
    <div
      className="fixed inset-0 z-[70] flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target && !addItem.isPending) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-[calc(100dvh-env(safe-area-inset-top))] w-full flex-col rounded-t-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] shadow-2xl sm:max-w-lg sm:rounded-lg"
      >
        <div className="flex items-start gap-4 border-b border-[hsl(var(--border))] p-5">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-xl font-semibold">Add to custom list</h2>
            <p className="mt-1 truncate text-sm text-[hsl(var(--muted-foreground))]">
              {title}
            </p>
          </div>
          <button
            type="button"
            aria-label="Close list picker"
            disabled={addItem.isPending}
            onClick={onClose}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-[hsl(var(--border))] disabled:opacity-50"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        <div className="min-h-48 overflow-y-auto p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
          {lists.isLoading ? (
            <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-[hsl(var(--muted-foreground))]">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Loading lists
            </div>
          ) : lists.isError ? (
            <div className="flex min-h-48 flex-col items-center justify-center gap-3 text-center">
              <p className="text-sm text-[hsl(var(--destructive))]">
                {getApiErrorMessage(lists.error, 'Your lists could not be loaded')}
              </p>
              <button
                type="button"
                onClick={() => void lists.refetch()}
                className="h-10 rounded-md border border-[hsl(var(--border))] px-4 text-sm font-medium"
              >
                Try again
              </button>
            </div>
          ) : lists.data?.length ? (
            <div className="divide-y divide-[hsl(var(--border))]">
              {lists.data.map((list) => (
                <button
                  key={list.id}
                  type="button"
                  disabled={addItem.isPending}
                  onClick={() =>
                    addItem.mutate(
                      { listId: list.id, mediaId },
                      { onSuccess: () => onAdded(list.name) },
                    )
                  }
                  className="flex min-h-16 w-full items-center gap-3 px-2 py-3 text-left transition-colors hover:bg-[hsl(var(--accent))] disabled:opacity-50"
                >
                  <ListPlus className="h-5 w-5 shrink-0 text-[hsl(var(--primary))]" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{list.name}</span>
                    <span className="flex items-center gap-1 text-xs text-[hsl(var(--muted-foreground))]">
                      {!list.is_public ? <Lock className="h-3 w-3" aria-hidden="true" /> : null}
                      {list.item_count} {list.item_count === 1 ? 'title' : 'titles'}
                    </span>
                  </span>
                  <Plus className="h-5 w-5 shrink-0" aria-hidden="true" />
                </button>
              ))}
            </div>
          ) : (
            <div className="flex min-h-48 flex-col items-center justify-center gap-3 px-5 text-center">
              <ListPlus className="h-8 w-8 text-[hsl(var(--muted-foreground))]" aria-hidden="true" />
              <div>
                <p className="font-medium">No custom lists yet</p>
                <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
                  Create one before adding this title.
                </p>
              </div>
              <Link
                to="/lists"
                onClick={onClose}
                className="flex h-10 items-center rounded-md bg-[hsl(var(--primary))] px-4 text-sm font-medium text-white"
              >
                Create a list
              </Link>
            </div>
          )}
          {addItem.error ? (
            <p className="px-2 pt-3 text-sm text-[hsl(var(--destructive))]" role="alert">
              {getApiErrorMessage(addItem.error, 'This title could not be added')}
            </p>
          ) : null}
        </div>
      </section>
    </div>
  );
}
