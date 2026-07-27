import {
  nextReaction,
  reactionAccessibilityLabel,
  reactionCaption,
  reactionCounts,
  totalReactions,
} from '@/lib/episode-reactions';
import { translate } from '@/lib/i18n';

// Using the real English resolver keeps these assertions readable while also
// asserting the `reactions.*` keys exist in the dictionary.
const t = (key: string, params?: Record<string, string | number>) => translate('en', key, params);

describe('episode reactions', () => {
  it('tells the viewer to watch first when they cannot react', () => {
    expect(reactionCaption(t, [], false)).toMatch(/mark the episode watched/i);
    // Even with existing reactions, the instruction wins: it explains why the
    // buttons are disabled.
    expect(reactionCaption(t, [{ reaction: 'loved', count: 3 }], false)).toMatch(
      /mark the episode watched/i,
    );
  });

  it('invites the first reaction and then counts them', () => {
    expect(reactionCaption(t, [], true)).toBe('Be the first to react.');
    expect(reactionCaption(t, [{ reaction: 'loved', count: 1 }], true)).toBe('1 reaction');
    expect(
      reactionCaption(
        t,
        [
          { reaction: 'loved', count: 2 },
          { reaction: 'sad', count: 4 },
        ],
        true,
      ),
    ).toBe('6 reactions');
  });

  it('totals and indexes the counts', () => {
    const reactions = [
      { reaction: 'loved', count: 2 },
      { reaction: 'tense', count: 5 },
    ] as const;
    expect(totalReactions([...reactions])).toBe(7);
    expect(reactionCounts([...reactions]).get('tense')).toBe(5);
    expect(reactionCounts([...reactions]).get('bored')).toBeUndefined();
  });

  it('clears the current reaction when it is tapped again', () => {
    expect(nextReaction('loved', 'loved')).toBeNull();
    expect(nextReaction('funny', 'loved')).toBe('funny');
    expect(nextReaction('funny', null)).toBe('funny');
  });

  it('announces the count only when there is one', () => {
    expect(reactionAccessibilityLabel(t, 'shocked', 4)).toBe('Shocked, 4');
    expect(reactionAccessibilityLabel(t, 'shocked', 0)).toBe('Shocked');
  });
});
