import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * What `aria-modal='true'` promises, for the dialog `dialogRef` points at:
 * the page behind stops scrolling, focus moves inside and Tab keeps it there,
 * Escape closes, and focus goes back to whatever opened the dialog.
 *
 * Four dialogs each carried their own copy of this, and the copies had drifted:
 * two only closed on Escape, so Tab walked out of the dialog into the page it
 * covers and focus was dropped on close; none counted an `<input>` as
 * focusable. One implementation is how the four stay the same.
 *
 * `canClose` is false while a request the dialog started is still running.
 */
export function useModalDialog(
  dialogRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  canClose = true,
) {
  const closeRef = useRef(onClose);
  const canCloseRef = useRef(canClose);

  useEffect(() => {
    closeRef.current = onClose;
    canCloseRef.current = canClose;
  }, [onClose, canClose]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.style.overflow = 'hidden';
    const focusableElements = () =>
      Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    focusableElements()[0]?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (canCloseRef.current) closeRef.current();
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
  }, [dialogRef]);
}
