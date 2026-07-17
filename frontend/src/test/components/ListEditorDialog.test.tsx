import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ListEditorDialog } from '@/components/ListEditorDialog';

describe('ListEditorDialog', () => {
  it('rejects blank names and submits normalized values', async () => {
    const user = userEvent.setup();
    const save = vi.fn();
    render(
      <ListEditorDialog
        pending={false}
        error={null}
        onClose={vi.fn()}
        onSave={save}
      />,
    );

    const name = screen.getByRole('textbox', { name: 'Name' });
    await user.type(name, '   ');
    await user.click(screen.getByRole('button', { name: 'Create list' }));
    expect(screen.getByRole('alert')).toHaveTextContent('cannot be blank');
    expect(save).not.toHaveBeenCalled();

    await user.clear(name);
    await user.type(name, '  Weekend movies  ');
    await user.type(
      screen.getByRole('textbox', { name: 'Description' }),
      '  Worth watching together.  ',
    );
    await user.click(screen.getByRole('checkbox', { name: /Public list/ }));
    await user.click(screen.getByRole('button', { name: 'Create list' }));

    expect(save).toHaveBeenCalledWith({
      name: 'Weekend movies',
      description: 'Worth watching together.',
      is_public: true,
    });
  });
});
