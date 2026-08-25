import {
  ArrowLeft,
  Check,
  Globe2,
  Flag,
  Loader2,
  Lock,
  Pencil,
  Share2,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';

import { AddFromLibrary } from '@/components/AddFromLibrary';
import { ListEditorDialog } from '@/components/ListEditorDialog';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { ReportDialog } from '@/components/ReportDialog';
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
import { usePageTitle } from '@/hooks/usePageTitle';
import { useT } from '@/hooks/useT';

export default function ListDetailPage() {
  const t = useT();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const user = useAuthStore((state) => state.user);
  const detail = useList(id);
  const updateList = useUpdateList();
  const deleteList = useDeleteList();
  const removeItem = useRemoveListItem();
  const [editing, setEditing] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [shared, setShared] = useState(false);
  usePageTitle(detail.data?.list?.name);

  if (detail.isLoading) return <LoadingSpinner />;
  if (detail.isError || !detail.data) {
    return (
      <div className="mx-auto flex min-h-[60dvh] max-w-xl flex-col items-center justify-center gap-4 px-4 text-center">
        <h1 className="text-xl font-semibold">{t('listDetail.unavailable')}</h1>
        <p className="text-sm text-[hsl(var(--muted-foreground))]">
          {getApiErrorMessage(detail.error, t('listDetail.unavailableHint'))}
        </p>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => void detail.refetch()}
            className="h-10 rounded-md border border-[hsl(var(--border))] px-4 text-sm font-medium"
          >
            {t('common.tryAgain')}
          </button>
          {user ? (
            <Link
              to="/lists"
              className="flex h-10 items-center rounded-md bg-[hsl(var(--primary))] px-4 text-sm font-medium text-[hsl(var(--primary-foreground))]"
            >
              {t('listDetail.myLists')}
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
    if (!window.confirm(t('lists.confirmDelete', { name: list.name }))) {
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
        {user ? t('listDetail.myLists') : t('nav.home')}
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
              {list.is_public ? t('listDetail.publicList') : t('listDetail.privateList')}
            </div>
            <h1 className="mt-2 break-words text-2xl font-bold sm:text-3xl">{list.name}</h1>
            {list.description ? (
              <p className="mt-2 max-w-3xl whitespace-pre-wrap text-sm leading-relaxed text-[hsl(var(--muted-foreground))]">
                {list.description}
              </p>
            ) : null}
            <p className="mt-3 text-xs text-[hsl(var(--muted-foreground))]">
              {items.length === 1
                ? t('lists.titleCountOne')
                : t('lists.titleCountMany', { count: items.length })}
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
                {shared ? t('listDetail.shared') : t('listDetail.share')}
              </button>
            ) : null}
            {user && list.is_public && !isOwner ? (
              <button
                type="button"
                onClick={() => setReporting(true)}
                className="flex h-10 items-center gap-2 rounded-md border border-[hsl(var(--border))] px-3 text-sm font-medium text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--destructive))]"
              >
                <Flag className="h-4 w-4" aria-hidden="true" />
                {t('safety.report')}
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
                  <Pencil className="h-4 w-4" aria-hidden="true" /> {t('common.edit')}
                </button>
                <button
                  type="button"
                  aria-label={t('lists.deleteName', { name: list.name })}
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
                  <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">
                    {item.media_type === 'tv' ? t('listDetail.tvShow') : t('listDetail.movie')}
                  </p>
                </div>
              </Link>
              {isOwner ? (
                <button
                  type="button"
                  title={t('listDetail.removeItem', { title: item.title, list: list.name })}
                  aria-label={t('listDetail.removeItem', { title: item.title, list: list.name })}
                  disabled={removeItem.isPending}
                  onClick={() => {
                    if (window.confirm(t('listDetail.confirmRemoveItem', { title: item.title }))) {
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
        <div
          // An owner has the way to fill it directly below, so reserving most
          // of a screen of blank space above that pushes the answer out of
          // sight. A visitor has nothing else on the page, so the room reads
          // as deliberate rather than wasted.
          className={`flex flex-col items-center justify-center gap-3 px-6 text-center ${
            isOwner ? 'min-h-32' : 'min-h-72'
          }`}
        >
          <p className="font-medium">{t('listDetail.empty')}</p>
          <p className="max-w-md text-sm text-[hsl(var(--muted-foreground))]">
            {isOwner ? t('listDetail.emptyOwner') : t('listDetail.emptyOther')}
          </p>
        </div>
      )}

      {/* Below the list rather than above it: what is already here is the
          point of the page, and this is how it grows. */}
      {isOwner ? (
        <AddFromLibrary
          listId={list.id}
          alreadyIn={new Set(items.map((item) => item.id))}
        />
      ) : null}

      {removeItem.error || deleteList.error ? (
        <p className="mt-4 text-sm text-[hsl(var(--destructive))]" role="alert">
          {getApiErrorMessage(
            removeItem.error ?? deleteList.error,
            t('listDetail.updateError'),
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
      {reporting ? (
        <ReportDialog
          targetType="list"
          targetId={list.id}
          targetLabel={list.name}
          onClose={() => setReporting(false)}
        />
      ) : null}
    </div>
  );
}
