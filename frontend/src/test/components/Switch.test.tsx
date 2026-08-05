import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Switch } from '@/components/Switch';

describe('Switch', () => {
  it('keeps the thumb inside the track in both states', () => {
    const { rerender } = render(
      <Switch checked={false} label="Private profile" onCheckedChange={() => {}} />,
    );

    const thumb = screen.getByRole('switch', { name: 'Private profile' }).firstElementChild;
    expect(thumb).toHaveClass('left-0.5', 'translate-x-0');

    rerender(<Switch checked label="Private profile" onCheckedChange={() => {}} />);
    expect(thumb).toHaveClass('left-0.5', 'translate-x-5');
  });

  it('requests the opposite state when activated', async () => {
    const onCheckedChange = vi.fn();
    render(
      <Switch checked={false} label="Private profile" onCheckedChange={onCheckedChange} />,
    );

    await userEvent.click(screen.getByRole('switch', { name: 'Private profile' }));

    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });
});
