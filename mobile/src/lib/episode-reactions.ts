import type { EpisodeReaction, ReactionCount } from '@/types';

/**
 * The decisions behind the reaction row, kept out of the component so they can
 * be tested without a renderer — the rest of this project's tests are logic
 * tests, and pulling in a render library for four branches is not worth the
 * dependency in an Expo app. The user-facing copy is resolved through a passed
 * `t` so these stay pure and locale-agnostic (see the `reactions.*` keys).
 */

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** Emoji is language-neutral, so it stays here rather than in the dictionary. */
export const REACTION_EMOJI: Record<EpisodeReaction, string> = {
  loved: '❤️',
  funny: '😂',
  shocked: '😱',
  sad: '😢',
  tense: '😬',
  bored: '🥱',
};

export function reactionLabel(t: Translate, reaction: EpisodeReaction): string {
  return t(`reactions.${reaction}`);
}

export function totalReactions(reactions: ReactionCount[]): number {
  return reactions.reduce((sum, entry) => sum + entry.count, 0);
}

export function reactionCounts(reactions: ReactionCount[]): Map<EpisodeReaction, number> {
  return new Map(reactions.map((entry) => [entry.reaction, entry.count]));
}

/** What the line under the heading says, in each of its three states. */
export function reactionCaption(
  t: Translate,
  reactions: ReactionCount[],
  canReact: boolean,
): string {
  if (!canReact) return t('reactions.markToReact');
  const total = totalReactions(reactions);
  if (total === 0) return t('reactions.beFirst');
  return total === 1 ? t('reactions.countOne') : t('reactions.countMany', { count: total });
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
  t: Translate,
  reaction: EpisodeReaction,
  count: number,
): string {
  const label = reactionLabel(t, reaction);
  return count > 0 ? t('reactions.labelWithCount', { label, count }) : label;
}
