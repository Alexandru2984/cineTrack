import { Star, Users } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import { AppText } from '@/components/app-text';
import { radius, spacing } from '@/constants/theme';
import { useCommunityRating } from '@/hooks/use-media';
import { useTheme } from '@/hooks/use-theme';
import type { MediaType } from '@/types';

function DistributionRow({ score, bucket, max }: { score: number; bucket: number; max: number }) {
  const theme = useTheme();
  // Two flex children instead of a percentage width so this stays within RN's
  // DimensionValue typing; the filled part scales to the busiest bucket.
  return (
    <View style={styles.row}>
      <AppText variant="caption" muted style={styles.rowScore}>
        {score}
      </AppText>
      <View style={[styles.track, { backgroundColor: theme.surface }]}>
        <View style={{ flex: bucket, backgroundColor: theme.primary }} />
        <View style={{ flex: Math.max(0, max - bucket) }} />
      </View>
      <AppText variant="caption" muted style={styles.rowCount}>
        {bucket}
      </AppText>
    </View>
  );
}

/**
 * Community rating card for a title: the aggregate of Văzute members' own
 * 1–10 ratings, shown alongside TMDB's score. Renders nothing until a member
 * has rated the title; below the server's display floor only the member count
 * is shown, never a number that would be one person's private rating.
 */
export function CommunityRating({ tmdbId, mediaType }: { tmdbId: number; mediaType: MediaType }) {
  const theme = useTheme();
  const { data } = useCommunityRating(String(tmdbId), mediaType);
  if (!data || data.count === 0) return null;

  const { count, average, distribution } = data;
  const memberLabel = count === 1 ? 'member' : 'members';
  const max = distribution ? Math.max(...distribution, 1) : 1;

  return (
    <View style={[styles.card, { backgroundColor: theme.elevated, borderColor: theme.border }]}>
      <View style={styles.heading}>
        <View style={styles.title}>
          <Users color={theme.primary} size={20} />
          <AppText variant="section">Văzute community</AppText>
        </View>
        {average != null ? (
          <View style={styles.score}>
            <Star color={theme.primary} fill={theme.primary} size={18} />
            <AppText variant="section">{average.toFixed(1)}</AppText>
            <AppText variant="caption" muted>
              /10
            </AppText>
          </View>
        ) : null}
      </View>

      {average != null && distribution ? (
        <>
          <View
            style={styles.distribution}
            accessibilityLabel={`Average ${average.toFixed(1)} out of 10 from ${count} ${
              count === 1 ? 'rating' : 'ratings'
            }.`}
          >
            {distribution
              .map((bucket, index) => ({ score: index + 1, bucket }))
              .reverse()
              .map(({ score, bucket }) => (
                <DistributionRow key={score} score={score} bucket={bucket} max={max} />
              ))}
          </View>
          <AppText variant="caption" muted>
            Based on {count} member {count === 1 ? 'rating' : 'ratings'}. Individual ratings stay
            private.
          </AppText>
        </>
      ) : (
        <AppText muted>
          Rated by {count} {memberLabel}. The community average appears once a few members have rated
          it.
        </AppText>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: spacing.md,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  heading: {
    minHeight: 32,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  title: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  score: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  distribution: {
    gap: spacing.xs,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  rowScore: {
    width: 20,
    textAlign: 'right',
  },
  track: {
    flex: 1,
    height: 10,
    flexDirection: 'row',
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  rowCount: {
    width: 28,
  },
});
