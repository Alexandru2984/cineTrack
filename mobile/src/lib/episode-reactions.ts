import type { EpisodeReaction, ReactionCount } from '@/types';

/**
 * The decisions behind the reaction row, kept out of the component so they can
 * be tested without a renderer — the rest of this project's tests are logic
 * tests, and pulling in a render library for four branches is not worth the
 * dependency in an Expo app.
 */

export const REACTION_LABELS: Record<EpisodeReaction, { emoji: string; label: string }> = {
  loved: { emoji: '❤️', label: 'Loved it' },
  funny: { emoji: '😂', label: 'Funny' },
  shocked: { emoji: '😱', label: 'Shocked' },
  sad: { emoji: '😢', label: 'Sad' },
  tense: { emoji: '😬', label: 'Tense' },
  bored: { emoji: '🥱', label: 'Bored' },
};

export function totalReactions(reactions: ReactionCount[]): number {
  return reactions.reduce((sum, entry) => sum + entry.count, 0);
}

export function reactionCounts(reactions: ReactionCount[]): Map<EpisodeReaction, number> {
  return new Map(reactions.map((entry) => [entry.reaction, entry.count]));
}

/** What the line under the heading says, in each of its three states. */
export function reactionCaption(reactions: ReactionCount[], canReact: boolean): string {
  if (!canReact) return 'Mark the episode watched to add your reaction.';
  const total = totalReactions(reactions);
  if (total === 0) return 'Be the first to react.';
  return `${total} ${total === 1 ? 'reaction' : 'reactions'}`;
}

/**
 * Tapping the reaction you already picked clears it; tapping another replaces
 * it. Returning null is what the caller sends to remove one.
 */
export function nextReaction(
  tapped: EpisodeReaction,
  current: EpisodeReaction | null,
): EpisodeReaction | null {
  return tapped === current ? null : tapped;
}

/** The accessibility label, which is also what the count is announced through. */
export function reactionAccessibilityLabel(
  reaction: EpisodeReaction,
  count: number,
): string {
  const { label } = REACTION_LABELS[reaction];
  return count > 0 ? `${label}, ${count}` : label;
}
