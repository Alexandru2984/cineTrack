import { Loader2, X } from 'lucide-react';
import { useEffect, useId, useState, type FormEvent } from 'react';

import { getApiErrorMessage } from '@/lib/api';
import type { ListInput } from '@/hooks/useLists';

interface EditableList {
  name: string;
  description: string | null;
  is_public: boolean;
}

export function ListEditorDialog({
  list,
  pending,
  error,
  onClose,
  onSave,
}: {
  list?: EditableList;
  pending: boolean;
  error: unknown;
  onClose: () => void;
  onSave: (input: ListInput) => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const [name, setName] = useState(list?.name ?? '');
  const [description, setDescription] = useState(list?.description ?? '');
  const [isPublic, setIsPublic] = useState(list?.is_public ?? false);
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !pending) onClose();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [onClose, pending]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setValidationError('List name cannot be blank.');
      return;
    }
    setValidationError(null);
    onSave({
      name: trimmedName,
      description: description.trim(),
      is_public: isPublic,
    });
  };

  return (
    <div
      className="fixed inset-0 z-[70] flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target && !pending) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="max-h-[calc(100dvh-env(safe-area-inset-top))] w-full overflow-y-auto rounded-t-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] shadow-2xl sm:max-w-lg sm:rounded-lg sm:p-6"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id={titleId} className="text-xl font-semibold">
              {list ? 'Edit list' : 'Create list'}
            </h2>
            <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
              Organize movies and shows independently from tracking status.
            </p>
          </div>
          <button
            type="button"
            aria-label="Close list editor"
            disabled={pending}
            onClick={onClose}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-[hsl(var(--border))] disabled:opacity-50"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        <form className="mt-6 space-y-5" onSubmit={submit}>
          <label className="block space-y-2">
            <span className="text-sm font-medium">Name</span>
            <input
              autoFocus
              required
              minLength={1}
              maxLength={200}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setValidationError(null);
              }}
              className="h-11 w-full rounded-md border border-[hsl(var(--input))] bg-transparent px-3 text-sm outline-none focus:border-[hsl(var(--primary))]"
              placeholder="Weekend movies"
            />
          </label>

          <div className="space-y-2">
            <label htmlFor={descriptionId} className="block text-sm font-medium">
              Description
            </label>
            <textarea
              id={descriptionId}
              maxLength={1000}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              className="min-h-28 w-full resize-y rounded-md border border-[hsl(var(--input))] bg-transparent px-3 py-2 text-sm outline-none focus:border-[hsl(var(--primary))]"
              placeholder="Optional context for this collection"
            />
            <span className="block text-right text-xs text-[hsl(var(--muted-foreground))]">
              {description.length}/1000
            </span>
          </div>

          <label className="flex min-h-12 cursor-pointer items-center justify-between gap-4 rounded-md border border-[hsl(var(--border))] px-3">
            <span className="min-w-0">
              <span className="block text-sm font-medium">Public list</span>
              <span className="block text-xs text-[hsl(var(--muted-foreground))]">
                Anyone with its link can view it.
              </span>
            </span>
            <input
              type="checkbox"
              checked={isPublic}
              onChange={(event) => setIsPublic(event.target.checked)}
              className="h-5 w-5 shrink-0 accent-[hsl(var(--primary))]"
            />
          </label>

          {validationError || error ? (
            <p className="text-sm text-[hsl(var(--destructive))]" role="alert">
              {validationError ?? getApiErrorMessage(error, 'The list could not be saved')}
            </p>
          ) : null}

          <div className="flex gap-3 pt-1">
            <button
              type="button"
              disabled={pending}
              onClick={onClose}
              className="h-11 flex-1 rounded-md border border-[hsl(var(--border))] px-4 text-sm font-medium disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={pending}
              className="flex h-11 flex-1 items-center justify-center gap-2 rounded-md bg-[hsl(var(--primary))] px-4 text-sm font-medium text-white disabled:opacity-50"
            >
              {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              {list ? 'Save changes' : 'Create list'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
