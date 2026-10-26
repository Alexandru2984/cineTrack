import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ListEditorDialog } from '@/components/ListEditorDialog';
import { useModalDialog } from '@/hooks/useModalDialog';

function Harness({ onClose, canClose = true }: { onClose: () => void; canClose?: boolean }) {
  const ref = useRef<HTMLElement>(null);
  useModalDialog(ref, onClose, canClose);
  return (
    <section ref={ref} role="dialog" aria-modal="true" tabIndex={-1}>
      <input aria-label="Name" />
      <button type="button">Save</button>
    </section>
  );
}

function Opener() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <button type="button">Behind</button>
      {open ? <Harness onClose={() => setOpen(false)} /> : null}
    </>
  );
}

describe('useModalDialog', () => {
  it('moves focus in, keeps Tab inside, and gives focus back on Escape', async () => {
    const user = userEvent.setup();
    render(<Opener />);
    const opener = screen.getByRole('button', { name: 'Open' });
    await user.click(opener);

    const name = screen.getByRole('textbox', { name: 'Name' });
    expect(name).toHaveFocus();
    expect(document.body.style.overflow).toBe('hidden');

    await user.tab();
    expect(screen.getByRole('button', { name: 'Save' })).toHaveFocus();
    // The page behind the dialog is never reached.
    await user.tab();
    expect(name).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Save' })).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
    expect(document.body.style.overflow).toBe('');
  });

  it('does not close on Escape while it cannot', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Harness onClose={onClose} canClose={false} />);
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('traps focus in the list editor, which used to let Tab out', async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">Behind</button>
        <ListEditorDialog pending={false} error={null} onClose={vi.fn()} onSave={vi.fn()} />
      </>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    for (let i = 0; i < 8; i += 1) {
      await user.tab();
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }
  });
});
