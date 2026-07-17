import {
  ChevronRight,
  Globe2,
  ListPlus,
  Loader2,
  Lock,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { ListEditorDialog } from '@/components/ListEditorDialog';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import {
  useCreateList,
  useDeleteList,
  useMyLists,
  useUpdateList,
  type ListInput,
} from '@/hooks/useLists';
import { getApiErrorMessage } from '@/lib/api';
import type { ListResponse } from '@/types';

type EditorState = { mode: 'create' } | { mode: 'edit'; list: ListResponse } | null;

export default function ListsPage() {
  const lists = useMyLists();
  const createList = useCreateList();
  const updateList = useUpdateList();
  const deleteList = useDeleteList();
  const [editor, setEditor] = useState<EditorState>(null);

  const openCreate = () => {
    createList.reset();
    setEditor({ mode: 'create' });
  };

  const openEdit = (list: ListResponse) => {
    updateList.reset();
    setEditor({ mode: 'edit', list });
  };

  const save = (input: ListInput) => {
    if (!editor) return;
    if (editor.mode === 'create') {
      createList.mutate(input, { onSuccess: () => setEditor(null) });
      return;
    }
    updateList.mutate(
      { id: editor.list.id, ...input },
      { onSuccess: () => setEditor(null) },
    );
  };

  const confirmDelete = (list: ListResponse) => {
    if (!window.confirm(`Delete “${list.name}”? The titles inside will not be deleted.`)) {
      return;
    }
    deleteList.mutate(list.id);
  };

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:py-8">
      <header className="flex min-h-16 items-center justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold sm:text-3xl">Custom lists</h1>
          <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
            Collections independent from your watching status.
          </p>
        </div>
        <button
          type="button"
          onClick={openCreate}
          className="flex h-10 shrink-0 items-center gap-2 rounded-md bg-[hsl(var(--primary))] px-3 text-sm font-medium text-white sm:px-4"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          <span className="hidden sm:inline">Create list</span>
          <span className="sm:hidden">Create</span>
        </button>
      </header>

      {lists.isLoading ? <LoadingSpinner /> : null}

      {lists.isError ? (
        <div className="flex min-h-64 flex-col items-center justify-center gap-3 text-center">
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
      ) : null}

      {!lists.isLoading && !lists.isError && !lists.data?.length ? (
        <div className="flex min-h-72 flex-col items-center justify-center gap-4 px-6 text-center">
          <ListPlus className="h-10 w-10 text-[hsl(var(--muted-foreground))]" aria-hidden="true" />
          <div>
            <h2 className="text-lg font-semibold">No custom lists</h2>
            <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
              Create a collection, then add titles from their detail pages.
            </p>
          </div>
          <button
            type="button"
            onClick={openCreate}
            className="h-10 rounded-md border border-[hsl(var(--border))] px-4 text-sm font-medium"
          >
            Create your first list
          </button>
        </div>
      ) : null}

      {lists.data?.length ? (
        <div className="mt-6 divide-y divide-[hsl(var(--border))] border-y border-[hsl(var(--border))]">
          {lists.data.map((list) => (
            <article key={list.id} className="flex min-h-24 items-center gap-3 py-4">
              <Link
                to={`/lists/${encodeURIComponent(list.id)}`}
                className="flex min-w-0 flex-1 items-center gap-3 rounded-md py-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[hsl(var(--primary))]"
              >
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-[hsl(var(--secondary))]">
                  {list.is_public ? (
                    <Globe2 className="h-5 w-5 text-[hsl(var(--primary))]" aria-hidden="true" />
                  ) : (
                    <Lock className="h-5 w-5 text-[hsl(var(--muted-foreground))]" aria-hidden="true" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold">{list.name}</span>
                  {list.description ? (
                    <span className="mt-0.5 block truncate text-sm text-[hsl(var(--muted-foreground))]">
                      {list.description}
                    </span>
                  ) : null}
                  <span className="mt-1 block text-xs text-[hsl(var(--muted-foreground))]">
                    {list.item_count} {list.item_count === 1 ? 'title' : 'titles'} · {list.is_public ? 'Public' : 'Private'}
                  </span>
                </span>
                <ChevronRight className="h-5 w-5 shrink-0 text-[hsl(var(--muted-foreground))]" aria-hidden="true" />
              </Link>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  title={`Edit ${list.name}`}
                  aria-label={`Edit ${list.name}`}
                  onClick={() => openEdit(list)}
                  className="flex h-10 w-10 items-center justify-center rounded-md border border-[hsl(var(--border))]"
                >
                  <Pencil className="h-4 w-4" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  title={`Delete ${list.name}`}
                  aria-label={`Delete ${list.name}`}
                  disabled={deleteList.isPending}
                  onClick={() => confirmDelete(list)}
                  className="flex h-10 w-10 items-center justify-center rounded-md border border-[hsl(var(--border))] text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--destructive))] disabled:opacity-50"
                >
                  {deleteList.isPending && deleteList.variables === list.id ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  )}
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : null}

      {deleteList.error ? (
        <p className="mt-4 text-sm text-[hsl(var(--destructive))]" role="alert">
          {getApiErrorMessage(deleteList.error, 'The list could not be deleted')}
        </p>
      ) : null}

      {editor ? (
        <ListEditorDialog
          list={editor.mode === 'edit' ? editor.list : undefined}
          pending={editor.mode === 'create' ? createList.isPending : updateList.isPending}
          error={editor.mode === 'create' ? createList.error : updateList.error}
          onClose={() => {
            if (!createList.isPending && !updateList.isPending) setEditor(null);
          }}
          onSave={save}
        />
      ) : null}
    </div>
  );
}
