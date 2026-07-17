import {
  ArrowLeft,
  Check,
  Globe2,
  Loader2,
  Lock,
  Pencil,
  Share2,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { ListEditorDialog } from '@/components/ListEditorDialog';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import {
  useDeleteList,
  useList,
  useRemoveListItem,
  useUpdateList,
  type ListInput,
} from '@/hooks/useLists';
import { getApiErrorMessage } from '@/lib/api';
import { getPosterUrl } from '@/lib/utils';
import { useAuthStore } from '@/store/auth';

export default function ListDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const user = useAuthStore((state) => state.user);
  const detail = useList(id);
  const updateList = useUpdateList();
  const deleteList = useDeleteList();
  const removeItem = useRemoveListItem();
  const [editing, setEditing] = useState(false);
  const [shared, setShared] = useState(false);

  if (detail.isLoading) return <LoadingSpinner />;
  if (detail.isError || !detail.data) {
    return (
      <div className="mx-auto flex min-h-[60dvh] max-w-xl flex-col items-center justify-center gap-4 px-4 text-center">
        <h1 className="text-xl font-semibold">List unavailable</h1>
        <p className="text-sm text-[hsl(var(--muted-foreground))]">
          {getApiErrorMessage(detail.error, 'This list is private, missing, or could not be loaded.')}
        </p>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => void detail.refetch()}
            className="h-10 rounded-md border border-[hsl(var(--border))] px-4 text-sm font-medium"
          >
            Try again
          </button>
          {user ? (
            <Link
              to="/lists"
              className="flex h-10 items-center rounded-md bg-[hsl(var(--primary))] px-4 text-sm font-medium text-white"
            >
              My lists
            </Link>
          ) : null}
        </div>
      </div>
    );
  }

  const { list, items } = detail.data;
  const isOwner = user?.id === list.user_id;

  const save = (input: ListInput) => {
    updateList.mutate(
      { id: list.id, ...input },
      { onSuccess: () => setEditing(false) },
    );
  };

  const confirmDelete = () => {
    if (!window.confirm(`Delete “${list.name}”? The titles inside will not be deleted.`)) {
      return;
    }
    deleteList.mutate(list.id, { onSuccess: () => navigate('/lists') });
  };

  const share = async () => {
    const data = { title: list.name, url: window.location.href };
    try {
      if (navigator.share) {
        await navigator.share(data);
      } else {
        await navigator.clipboard.writeText(data.url);
      }
      setShared(true);
      window.setTimeout(() => setShared(false), 2000);
    } catch {
      // Cancelling the native share sheet is not an application error.
    }
  };

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:py-8">
      <Link
        to={user ? '/lists' : '/'}
        className="inline-flex min-h-10 items-center gap-2 text-sm text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        {user ? 'My lists' : 'Home'}
      </Link>

      <header className="mt-3 border-b border-[hsl(var(--border))] pb-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm text-[hsl(var(--muted-foreground))]">
              {list.is_public ? (
                <Globe2 className="h-4 w-4" aria-hidden="true" />
              ) : (
                <Lock className="h-4 w-4" aria-hidden="true" />
              )}
              {list.is_public ? 'Public list' : 'Private list'}
            </div>
            <h1 className="mt-2 break-words text-2xl font-bold sm:text-3xl">{list.name}</h1>
            {list.description ? (
              <p className="mt-2 max-w-3xl whitespace-pre-wrap text-sm leading-relaxed text-[hsl(var(--muted-foreground))]">
                {list.description}
              </p>
            ) : null}
            <p className="mt-3 text-xs text-[hsl(var(--muted-foreground))]">
              {items.length} {items.length === 1 ? 'title' : 'titles'}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            {list.is_public ? (
              <button
                type="button"
                onClick={() => void share()}
                className="flex h-10 items-center gap-2 rounded-md border border-[hsl(var(--border))] px-3 text-sm font-medium"
              >
                {shared ? <Check className="h-4 w-4" aria-hidden="true" /> : <Share2 className="h-4 w-4" aria-hidden="true" />}
                {shared ? 'Shared' : 'Share'}
              </button>
            ) : null}
            {isOwner ? (
              <>
                <button
                  type="button"
                  onClick={() => {
                    updateList.reset();
                    setEditing(true);
                  }}
                  className="flex h-10 items-center gap-2 rounded-md border border-[hsl(var(--border))] px-3 text-sm font-medium"
                >
                  <Pencil className="h-4 w-4" aria-hidden="true" /> Edit
                </button>
                <button
                  type="button"
                  aria-label={`Delete ${list.name}`}
                  disabled={deleteList.isPending}
                  onClick={confirmDelete}
                  className="flex h-10 w-10 items-center justify-center rounded-md border border-[hsl(var(--border))] text-[hsl(var(--destructive))] disabled:opacity-50"
                >
                  {deleteList.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  )}
                </button>
              </>
            ) : null}
          </div>
        </div>
      </header>

      {items.length ? (
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {items.map((item) => (
            <article
              key={item.id}
              className="group relative overflow-hidden rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))]"
            >
              <Link to={`/media/${item.tmdb_id}?type=${item.media_type}`} className="block">
                <div className="aspect-[2/3] bg-[hsl(var(--muted))]">
                  <img
                    src={getPosterUrl(item.poster_path)}
                    alt={item.title}
                    loading="lazy"
                    className="h-full w-full object-cover"
                  />
                </div>
                <div className="min-h-16 p-3">
                  <h2 className="line-clamp-2 text-sm font-medium">{item.title}</h2>
                  <p className="mt-1 text-xs capitalize text-[hsl(var(--muted-foreground))]">
                    {item.media_type === 'tv' ? 'TV show' : 'Movie'}
                  </p>
                </div>
              </Link>
              {isOwner ? (
                <button
                  type="button"
                  title={`Remove ${item.title} from ${list.name}`}
                  aria-label={`Remove ${item.title} from ${list.name}`}
                  disabled={removeItem.isPending}
                  onClick={() => {
                    if (window.confirm(`Remove “${item.title}” from this list?`)) {
                      removeItem.mutate({ listId: list.id, mediaId: item.id });
                    }
                  }}
                  className="absolute right-2 top-2 flex h-9 w-9 items-center justify-center rounded-md bg-black/75 text-white opacity-100 transition-opacity disabled:opacity-50 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </button>
              ) : null}
            </article>
          ))}
        </div>
      ) : (
        <div className="flex min-h-72 flex-col items-center justify-center gap-3 px-6 text-center">
          <p className="font-medium">This list is empty</p>
          <p className="max-w-md text-sm text-[hsl(var(--muted-foreground))]">
            {isOwner
              ? 'Open a movie or show and use “Custom list” to add it here.'
              : 'The owner has not added any titles yet.'}
          </p>
        </div>
      )}

      {removeItem.error || deleteList.error ? (
        <p className="mt-4 text-sm text-[hsl(var(--destructive))]" role="alert">
          {getApiErrorMessage(
            removeItem.error ?? deleteList.error,
            'The list could not be updated',
          )}
        </p>
      ) : null}

      {editing ? (
        <ListEditorDialog
          list={list}
          pending={updateList.isPending}
          error={updateList.error}
          onClose={() => {
            if (!updateList.isPending) setEditing(false);
          }}
          onSave={save}
        />
      ) : null}
    </div>
  );
}
