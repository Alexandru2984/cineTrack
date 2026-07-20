import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EpisodeReactions } from '@/components/EpisodeReactions';

describe('EpisodeReactions', () => {
  it('cannot be used before the episode is watched', async () => {
    const onSelect = vi.fn();
    render(
      <EpisodeReactions reactions={[]} myReaction={null} canReact={false} pending={false} onSelect={onSelect} />,
    );

    expect(screen.getByText(/mark the episode watched/i)).toBeInTheDocument();
    const loved = screen.getByRole('button', { name: /loved it/i });
    expect(loved).toBeDisabled();
    await userEvent.click(loved);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('reports totals without naming anyone', () => {
    render(
      <EpisodeReactions
        reactions={[
          { reaction: 'shocked', count: 4 },
          { reaction: 'loved', count: 2 },
        ]}
        myReaction={null}
        canReact
        pending={false}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByText('6 reactions')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /shocked, 4/i })).toBeInTheDocument();
  });

  it('marks the viewer’s own reaction and clears it when tapped again', async () => {
    const onSelect = vi.fn();
    render(
      <EpisodeReactions
        reactions={[{ reaction: 'loved', count: 1 }]}
        myReaction="loved"
        canReact
        pending={false}
        onSelect={onSelect}
      />,
    );

    const loved = screen.getByRole('button', { name: /loved it/i });
    expect(loved).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(loved);
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it('sends the chosen reaction when a different one is picked', async () => {
    const onSelect = vi.fn();
    render(
      <EpisodeReactions
        reactions={[]}
        myReaction="loved"
        canReact
        pending={false}
        onSelect={onSelect}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /funny/i }));
    expect(onSelect).toHaveBeenCalledWith('funny');
  });
});
