import { Award, Flame, Layers, Zap } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import { AppText } from '@/components/app-text';
import { radius, spacing } from '@/constants/theme';
import { useBadges } from '@/hooks/use-badges';
import { useT } from '@/hooks/use-t';
import { useTheme } from '@/hooks/use-theme';
import type { EarnedBadge } from '@/types';

/** One icon per family, so the shelf reads at a glance rather than as a row of
 *  identical medals. */
const FAMILY_ICONS = {
  marathon24: Flame,
  marathon48: Flame,
  sameday: Zap,
  juggler: Layers,
  volume: Award,
} as const;

function BadgeCard({ badge }: { badge: EarnedBadge }) {
  const t = useT();
  const theme = useTheme();
  const Icon = FAMILY_ICONS[badge.family as keyof typeof FAMILY_ICONS] ?? Award;
  const [first] = badge.shows;

  // Account-wide badges name no show; a tier earned once names it; more than
  // once counts. Listing every show is what made the old app's shelf unusable.
  const subtitle = (() => {
    if (badge.shows.length === 0) return null;
    if (badge.count === 1 && first) return t('badges.earnedForOne', { title: first.title });
    return t('badges.earnedFor', { count: badge.count });
  })();

  return (
    <View style={[styles.card, { borderColor: theme.border, backgroundColor: theme.surface }]}>
      <View style={[styles.icon, { backgroundColor: theme.infoSoft }]}>
        <Icon color={theme.primary} size={18} />
      </View>
      <View style={styles.cardText}>
        <AppText variant="label">{t(`badges.${badge.key}`)}</AppText>
        {subtitle ? (
          <AppText variant="caption" style={{ color: theme.mutedText }}>
            {subtitle}
          </AppText>
        ) : null}
      </View>
    </View>
  );
}

export function BadgeShelf() {
  const t = useT();
  const theme = useTheme();
  const { data, isLoading, isError } = useBadges();

  if (isLoading || !data) return null;
  if (isError) {
    return (
      <AppText variant="caption" style={{ color: theme.danger }}>
        {t('badges.loadError')}
      </AppText>
    );
  }

  return (
    <View style={styles.section}>
      <AppText variant="section">{t('badges.title')}</AppText>

      {data.earned.length === 0 ? (
        <View style={[styles.card, { borderColor: theme.border }]}>
          <View style={styles.cardText}>
            <AppText variant="label">{t('badges.empty')}</AppText>
            <AppText variant="caption" style={{ color: theme.mutedText }}>
              {t('badges.emptyHint')}
            </AppText>
          </View>
        </View>
      ) : (
        data.earned.map((badge) => <BadgeCard key={badge.key} badge={badge} />)
      )}

      {/* What to aim at next. Families with every tier earned are absent by
          design: a bar that cannot move says less than nothing. */}
      {data.progress.slice(0, 3).map((item) => (
        <View key={item.family} style={styles.progress}>
          <View style={styles.progressRow}>
            <AppText variant="caption" style={{ color: theme.mutedText }}>
              {t('badges.next', { label: t(`badges.${item.next_key}`) })}
            </AppText>
            <AppText variant="caption" style={{ color: theme.mutedText }}>
              {t('badges.progress', { current: item.current, threshold: item.threshold })}
            </AppText>
          </View>
          <View
            accessibilityRole="progressbar"
            accessibilityValue={{ min: 0, max: item.threshold, now: item.current }}
            style={[styles.track, { backgroundColor: theme.border }]}
          >
            <View
              style={[
                styles.fill,
                {
                  backgroundColor: theme.primary,
                  width: `${Math.min(100, (item.current / item.threshold) * 100)}%`,
                },
              ]}
            />
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: spacing.sm },
  card: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.lg,
    padding: spacing.sm,
  },
  icon: {
    height: 36,
    width: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardText: { flex: 1, gap: 2 },
  progress: { gap: spacing.xs },
  progressRow: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm },
  track: { height: 6, borderRadius: 3, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 3 },
});
