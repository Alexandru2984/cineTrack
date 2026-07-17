import { Minus, Plus, Star, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

import {
  buildTrackingFeedbackPayload,
  MAX_REVIEW_LENGTH,
  type TrackingFeedbackPayload,
} from '@/lib/trackingFeedback';
import type { TrackingItem } from '@/types';

export function TrackingFeedbackDialog({
  item,
  pending,
  error,
  onClose,
  onSave,
}: {
  item: TrackingItem;
  pending: boolean;
  error?: string;
  onClose: () => void;
  onSave: (payload: TrackingFeedbackPayload) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const [rating, setRating] = useState<number | null>(item.rating);
  const [review, setReview] = useState(item.review ?? '');

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    closeButtonRef.current?.focus();

    return () => {
      if (typeof dialog.close === 'function' && dialog.open) dialog.close();
      else dialog.removeAttribute('open');
    };
  }, []);

  const changeRating = (change: number) => {
    setRating((current) => Math.min(10, Math.max(1, (current ?? 0) + change)));
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !pending) onClose();
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-lg rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-0 text-[hsl(var(--foreground))] shadow-2xl backdrop:bg-black/65"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSave(buildTrackingFeedbackPayload(rating, review));
        }}
      >
        <header className="flex min-h-16 items-start gap-3 border-b border-[hsl(var(--border))] p-4">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-lg font-semibold">Your rating and review</h2>
            <p id={descriptionId} className="mt-1 truncate text-sm text-[hsl(var(--muted-foreground))]">
              {item.title}
            </p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            aria-label="Close rating editor"
            disabled={pending}
            onClick={onClose}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--secondary))] disabled:opacity-50"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </header>

        <div className="space-y-6 p-4">
          <fieldset>
            <legend className="mb-2 text-sm font-medium">Rating</legend>
            <div className="flex min-h-11 flex-wrap items-center gap-2">
              <button
                type="button"
                aria-label="Decrease rating"
                disabled={pending || rating === null || rating <= 1}
                onClick={() => changeRating(-1)}
                className="flex h-11 w-11 items-center justify-center rounded-md border border-[hsl(var(--border))] disabled:opacity-40"
              >
                <Minus className="h-5 w-5" aria-hidden="true" />
              </button>
              <output
                aria-live="polite"
                className="flex h-11 min-w-24 items-center justify-center gap-1 rounded-md bg-amber-500/10 px-3 text-amber-600 dark:text-amber-400"
              >
                <Star className={`h-5 w-5 ${rating === null ? '' : 'fill-current'}`} aria-hidden="true" />
                <span className="text-lg font-semibold">{rating === null ? '-' : rating}</span>
                <span className="text-xs">/10</span>
              </output>
              <button
                type="button"
                aria-label="Increase rating"
                disabled={pending || rating === 10}
                onClick={() => changeRating(1)}
                className="flex h-11 w-11 items-center justify-center rounded-md border border-[hsl(var(--border))] disabled:opacity-40"
              >
                <Plus className="h-5 w-5" aria-hidden="true" />
              </button>
              <button
                type="button"
                disabled={pending || rating === null}
                onClick={() => setRating(null)}
                className="h-11 rounded-md border border-[hsl(var(--border))] px-3 text-sm font-medium disabled:opacity-40"
              >
                Clear rating
              </button>
            </div>
          </fieldset>

          <div>
            <div className="mb-2 flex items-center justify-between gap-3">
              <label htmlFor={`${descriptionId}-review`} className="text-sm font-medium">Review</label>
              <span className="text-xs text-[hsl(var(--muted-foreground))]">
                {review.length}/{MAX_REVIEW_LENGTH}
              </span>
            </div>
            <textarea
              id={`${descriptionId}-review`}
              value={review}
              disabled={pending}
              maxLength={MAX_REVIEW_LENGTH}
              rows={6}
              placeholder="What did you think?"
              onChange={(event) => setReview(event.target.value)}
              className="w-full resize-y rounded-md border border-[hsl(var(--input))] bg-transparent p-3 text-sm leading-relaxed outline-none focus:border-[hsl(var(--primary))] focus:ring-2 focus:ring-[hsl(var(--primary))]/20 disabled:opacity-60"
            />
          </div>

          {error && (
            <p role="alert" className="rounded-md bg-[hsl(var(--destructive))]/10 p-3 text-sm text-[hsl(var(--destructive))]">
              {error}
            </p>
          )}
        </div>

        <footer className="flex gap-3 border-t border-[hsl(var(--border))] p-4">
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
            className="h-11 flex-1 rounded-md bg-[hsl(var(--primary))] px-4 text-sm font-medium text-white disabled:opacity-50"
          >
            {pending ? 'Saving...' : 'Save'}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
