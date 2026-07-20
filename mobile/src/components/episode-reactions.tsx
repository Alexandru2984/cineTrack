import { Pressable, StyleSheet, View } from 'react-native';

import { AppText } from '@/components/app-text';
import { radius, spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  REACTION_LABELS,
  reactionAccessibilityLabel,
  reactionCaption,
  reactionCounts,
} from '@/lib/episode-reactions';
import { EPISODE_REACTIONS } from '@/types';
import type { EpisodeReaction, ReactionCount } from '@/types';

/**
 * A fixed set of reactions rather than a comment box.
 *
 * Anything a user can type is user-generated content, which brings reporting,
 * blocking and moderation duties with it on a store listing. A closed
 * vocabulary carries none of that and cannot hold a slur or a spoiler, while
 * still showing how an episode landed with everyone else.
 *
 * Only totals are shown — never who reacted — so a private profile stays
 * private without this component knowing anything about visibility.
 */
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
  const theme = useTheme();
  const counts = reactionCounts(reactions);
  const caption = reactionCaption(reactions, canReact);

  return (
    <View style={[styles.section, { borderTopColor: theme.border }]}>
      <AppText variant="section">How it landed</AppText>
      <AppText muted variant="caption" style={styles.caption}>
        {caption}
      </AppText>

      <View style={styles.row}>
        {EPISODE_REACTIONS.map((reaction) => {
          const { emoji, label } = REACTION_LABELS[reaction];
          const count = counts.get(reaction) ?? 0;
          const mine = myReaction === reaction;
          return (
            <Pressable
              key={reaction}
              // Tapping your own reaction again clears it.
              onPress={() => onSelect(mine ? null : reaction)}
              disabled={!canReact || pending}
              accessibilityRole="button"
              accessibilityState={{ selected: mine, disabled: !canReact || pending }}
              accessibilityLabel={reactionAccessibilityLabel(reaction, count)}
              style={[
                styles.chip,
                {
                  borderColor: mine ? theme.primary : theme.border,
                  backgroundColor: mine ? theme.primarySoft : 'transparent',
                  opacity: !canReact || pending ? 0.5 : 1,
                },
              ]}
            >
              <AppText variant="label">{emoji}</AppText>
              <AppText variant="label">{label}</AppText>
              {count > 0 ? (
                <AppText variant="label" muted>
                  {count}
                </AppText>
              ) : null}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
  },
  caption: {
    marginTop: spacing.xs,
  },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  chip: {
    alignItems: 'center',
    borderRadius: radius.lg,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
});
