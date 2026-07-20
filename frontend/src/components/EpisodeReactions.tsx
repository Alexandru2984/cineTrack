import { EPISODE_REACTIONS } from '@/types';
import type { EpisodeReaction, ReactionCount } from '@/types';

/**
 * A fixed set of reactions rather than a comment box.
 *
 * Anything a user can type is user-generated content, which brings reporting,
 * blocking and moderation duties with it on a public store listing. A closed
 * vocabulary carries none of that and cannot hold a slur or a spoiler, while
 * still showing how an episode landed with everyone else.
 *
 * Only totals are shown — never who reacted — so a private profile stays
 * private without this component knowing anything about visibility.
 */
const REACTION_LABELS: Record<EpisodeReaction, { emoji: string; label: string }> = {
  loved: { emoji: '❤️', label: 'Loved it' },
  funny: { emoji: '😂', label: 'Funny' },
  shocked: { emoji: '😱', label: 'Shocked' },
  sad: { emoji: '😢', label: 'Sad' },
  tense: { emoji: '😬', label: 'Tense' },
  bored: { emoji: '🥱', label: 'Bored' },
};

interface EpisodeReactionsProps {
  reactions: ReactionCount[];
  myReaction: EpisodeReaction | null;
  /** Reacting requires having watched the episode, matching the API. */
  canReact: boolean;
  pending: boolean;
  onSelect: (reaction: EpisodeReaction | null) => void;
}

export function EpisodeReactions({
  reactions,
  myReaction,
  canReact,
  pending,
  onSelect,
}: EpisodeReactionsProps) {
  const counts = new Map(reactions.map((entry) => [entry.reaction, entry.count]));
  const total = reactions.reduce((sum, entry) => sum + entry.count, 0);

  return (
    <section className="border-t border-[hsl(var(--border))] py-7" aria-labelledby="episode-reactions">
      <h2 id="episode-reactions" className="text-lg font-semibold">
        How it landed
      </h2>
      <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
        {!canReact
          ? 'Mark the episode watched to add your reaction.'
          : total === 0
            ? 'Be the first to react.'
            : `${total} ${total === 1 ? 'reaction' : 'reactions'}`}
      </p>

      <ul className="mt-4 flex flex-wrap gap-2">
        {EPISODE_REACTIONS.map((reaction) => {
          const { emoji, label } = REACTION_LABELS[reaction];
          const count = counts.get(reaction) ?? 0;
          const mine = myReaction === reaction;
          return (
            <li key={reaction}>
              <button
                type="button"
                // Tapping your own reaction again clears it.
                onClick={() => onSelect(mine ? null : reaction)}
                disabled={!canReact || pending}
                aria-pressed={mine}
                aria-label={`${label}${count > 0 ? `, ${count}` : ''}`}
                className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors disabled:opacity-50 ${
                  mine
                    ? 'border-[hsl(var(--primary))] bg-[hsl(var(--accent))]'
                    : 'border-[hsl(var(--border))] hover:bg-[hsl(var(--accent))]'
                }`}
              >
                <span aria-hidden="true">{emoji}</span>
                <span>{label}</span>
                {count > 0 && (
                  <span className="tabular-nums text-[hsl(var(--muted-foreground))]">{count}</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
