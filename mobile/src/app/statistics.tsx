import { Redirect, router } from 'expo-router';
import {
  ChevronLeft,
  ChevronRight,
  Clock3,
  Film,
  Flame,
  ListVideo,
  Sparkles,
  Trophy,
  Tv,
} from 'lucide-react-native';
import { useMemo, useState } from 'react';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppButton } from '@/components/app-button';
import { AppText } from '@/components/app-text';
import { EmptyState, ErrorState, LoadingState } from '@/components/screen-state';
import { radius, spacing } from '@/constants/theme';
import {
  useGenreDistribution,
  useHeatmap,
  useMonthlyActivity,
  useMyStats,
} from '@/hooks/use-stats';
import { useT } from '@/hooks/use-t';
import { useTheme } from '@/hooks/use-theme';
import { formatDate } from '@/lib/format';
import {
  buildHeatmapWeeks,
  formatActivityMonth,
  type HeatmapCell,
} from '@/lib/statistics';
import { hasLocalSession, useAuthStore } from '@/store/auth';

const HEATMAP_CELL = 12;
const HEATMAP_GAP = 3;
const MIN_HEATMAP_YEAR = 1900;

export default function StatisticsScreen() {
  const theme = useTheme();
  const t = useT();
  const status = useAuthStore((state) => state.status);
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear);
  const [selectedDay, setSelectedDay] = useState<HeatmapCell | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const hasSession = hasLocalSession(status);
  const stats = useMyStats(hasSession);
  const heatmap = useHeatmap(year, hasSession);
  const genres = useGenreDistribution(hasSession);
  const monthly = useMonthlyActivity(hasSession);
  const weeks = useMemo(
    () => buildHeatmapWeeks(year, heatmap.data ?? []),
    [heatmap.data, year],
  );
  const maxMonthlyHours = Math.max(1, ...(monthly.data ?? []).map((entry) => entry.hours));
  const visibleGenres = (genres.data ?? []).slice(0, 10);
  const maxGenreCount = Math.max(1, ...visibleGenres.map((entry) => entry.count));
  const hasError = stats.isError || heatmap.isError || genres.isError || monthly.isError;

  if (!hasSession) return <Redirect href="/" />;

  const refresh = async () => {
    setRefreshing(true);
    try {
      await Promise.all([
        stats.refetch(),
        heatmap.refetch(),
        genres.refetch(),
        monthly.refetch(),
      ]);
    } finally {
      setRefreshing(false);
    }
  };

  if (stats.isLoading) return <LoadingState label={t('statistics.loading')} />;
  if (!stats.data) {
    return (
      <ErrorState
        message={t('statistics.loadError')}
        onRetry={() => void stats.refetch()}
      />
    );
  }

  const heatmapColors = [
    theme.surface,
    theme.primarySoft,
    theme.info,
    theme.success,
    theme.warning,
  ];

  return (
    <SafeAreaView
      style={[styles.safeArea, { backgroundColor: theme.background }]}
      edges={['bottom']}
    >
      <ScrollView
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void refresh()}
            tintColor={theme.primary}
            colors={[theme.primary]}
          />
        }
        contentContainerStyle={styles.content}
      >
        <View
          style={[
            styles.recap,
            { backgroundColor: theme.primarySoft, borderColor: theme.primary },
          ]}
        >
          <View style={styles.recapCopy}>
            <Sparkles color={theme.primary} size={21} />
            <View style={styles.sectionCopy}>
              <AppText variant="section">{t('statistics.recapTitle')}</AppText>
              <AppText variant="caption" muted>
                {t('statistics.recapSubtitle')}
              </AppText>
            </View>
          </View>
          <AppButton
            label={t('statistics.openRecap')}
            compact
            onPress={() => router.push('/wrapped')}
          />
        </View>

        <View style={styles.statGrid}>
          <Stat icon={Film} label={t('stats.movies')} value={stats.data.total_movies} color={theme.primary} />
          <Stat icon={Tv} label={t('stats.shows')} value={stats.data.total_shows} color={theme.info} />
          <Stat
            icon={ListVideo}
            label={t('stats.episodes')}
            value={stats.data.total_episodes}
            color={theme.success}
          />
          <Stat
            icon={Clock3}
            label={t('stats.hours')}
            value={Math.round(stats.data.total_hours)}
            color={theme.warning}
          />
          <Stat
            icon={Flame}
            label={t('statistics.currentStreak')}
            value={t('statistics.streakValue', { days: stats.data.current_streak })}
            color={theme.danger}
          />
          <Stat
            icon={Trophy}
            label={t('statistics.bestStreak')}
            value={t('statistics.streakValue', { days: stats.data.longest_streak })}
            color={theme.warning}
          />
        </View>

        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <AppText variant="section" style={styles.sectionCopy}>
              {t('statistics.watchActivity')}
            </AppText>
            <View style={styles.yearControl}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('statistics.prevYear')}
                disabled={year <= MIN_HEATMAP_YEAR || heatmap.isFetching}
                onPress={() => {
                  setSelectedDay(null);
                  setYear((value) => Math.max(MIN_HEATMAP_YEAR, value - 1));
                }}
                style={[
                  styles.yearButton,
                  {
                    borderColor: theme.border,
                    opacity:
                      year <= MIN_HEATMAP_YEAR || heatmap.isFetching ? 0.4 : 1,
                  },
                ]}
              >
                <ChevronLeft color={theme.mutedText} size={18} />
              </Pressable>
              <AppText variant="label" style={styles.yearLabel}>
                {year}
              </AppText>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('statistics.nextYear')}
                disabled={year >= currentYear || heatmap.isFetching}
                onPress={() => {
                  setSelectedDay(null);
                  setYear((value) => Math.min(currentYear, value + 1));
                }}
                style={[
                  styles.yearButton,
                  {
                    borderColor: theme.border,
                    opacity: year >= currentYear || heatmap.isFetching ? 0.4 : 1,
                  },
                ]}
              >
                <ChevronRight color={theme.mutedText} size={18} />
              </Pressable>
            </View>
          </View>

          {heatmap.isLoading ? (
            <LoadingState label={t('statistics.loadingActivity')} />
          ) : heatmap.isError ? (
            <ErrorState
              message={t('statistics.activityLoadError')}
              onRetry={() => void heatmap.refetch()}
            />
          ) : (
            <>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.heatmapScroll}
              >
                <View style={styles.weekdayLabels}>
                  {t('statistics.weekdayInitials')
                    .split('')
                    .map((label, index) => (
                      <AppText
                        key={`${label}-${index}`}
                        variant="caption"
                        muted
                        style={styles.weekdayLabel}
                      >
                        {index % 2 === 1 ? label : ''}
                      </AppText>
                    ))}
                </View>
                <View style={styles.heatmap}>
                  {weeks.map((week, weekIndex) => (
                    <View key={weekIndex} style={styles.week}>
                      {week.map((cell, dayIndex) =>
                        cell.date ? (
                          <Pressable
                            key={cell.date}
                            accessibilityRole="button"
                            accessibilityLabel={t(
                              cell.count === 1
                                ? 'statistics.cellAriaOne'
                                : 'statistics.cellAriaMany',
                              { date: formatDate(cell.date), count: cell.count },
                            )}
                            hitSlop={2}
                            onPress={() => setSelectedDay(cell)}
                            style={[
                              styles.heatmapCell,
                              {
                                backgroundColor: heatmapColors[cell.level],
                                borderColor:
                                  selectedDay?.date === cell.date
                                    ? theme.text
                                    : 'transparent',
                              },
                            ]}
                          />
                        ) : (
                          <View
                            key={`empty-${dayIndex}`}
                            style={[styles.heatmapCell, styles.heatmapPlaceholder]}
                          />
                        ),
                      )}
                    </View>
                  ))}
                </View>
              </ScrollView>
              <View style={styles.heatmapFooter}>
                <AppText variant="caption" muted>
                  {selectedDay?.date
                    ? t(
                        selectedDay.count === 1
                          ? 'statistics.dayDetailOne'
                          : 'statistics.dayDetailMany',
                        { date: formatDate(selectedDay.date), count: selectedDay.count },
                      )
                    : (() => {
                        const total = (heatmap.data ?? []).reduce(
                          (sum, day) => sum + day.count,
                          0,
                        );
                        return t(
                          total === 1 ? 'statistics.yearTotalOne' : 'statistics.yearTotalMany',
                          { count: total, year },
                        );
                      })()}
                </AppText>
                <View style={styles.legend}>
                  <AppText variant="caption" muted>{t('statistics.legendLow')}</AppText>
                  {heatmapColors.slice(1).map((color, index) => (
                    <View
                      key={index}
                      style={[styles.legendCell, { backgroundColor: color }]}
                    />
                  ))}
                  <AppText variant="caption" muted>{t('statistics.legendHigh')}</AppText>
                </View>
              </View>
            </>
          )}
        </View>

        <View style={styles.section}>
          <AppText variant="section">{t('statistics.monthlyActivity')}</AppText>
          {monthly.isLoading ? (
            <LoadingState label={t('statistics.loadingMonthly')} />
          ) : monthly.data?.length ? (
            <View style={styles.bars}>
              {monthly.data.map((entry) => (
                <BarRow
                  key={entry.month}
                  label={formatActivityMonth(entry.month)}
                  ratio={entry.hours / maxMonthlyHours}
                  color={theme.info}
                  value={t('statistics.monthlyValue', {
                    hours: entry.hours.toFixed(1),
                    count: entry.count,
                  })}
                />
              ))}
            </View>
          ) : (
            <EmptyState
              icon={Clock3}
              title={t('statistics.noMonthlyTitle')}
              message={t('statistics.noMonthlyMessage')}
            />
          )}
        </View>

        <View style={styles.section}>
          <AppText variant="section">{t('statistics.topGenres')}</AppText>
          {genres.isLoading ? (
            <LoadingState label={t('statistics.loadingGenres')} />
          ) : visibleGenres.length ? (
            <View style={styles.bars}>
              {visibleGenres.map((entry, index) => (
                <BarRow
                  key={entry.genre}
                  label={entry.genre}
                  ratio={entry.count / maxGenreCount}
                  color={[theme.primary, theme.info, theme.success, theme.warning][index % 4]}
                  value={String(entry.count)}
                />
              ))}
            </View>
          ) : (
            <EmptyState
              icon={Film}
              title={t('statistics.noGenresTitle')}
              message={t('statistics.noGenresMessage')}
            />
          )}
        </View>

        {hasError ? (
          <AppText variant="caption" style={{ color: theme.danger }}>
            {t('statistics.refreshError')}
          </AppText>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  color,
}: {
  icon: typeof Film;
  label: string;
  value: string | number;
  color: string;
}) {
  const theme = useTheme();
  return (
    <View style={[styles.stat, { borderColor: theme.border, backgroundColor: theme.elevated }]}>
      <Icon color={color} size={19} />
      <AppText variant="section">{value}</AppText>
      <AppText variant="caption" muted numberOfLines={2}>
        {label}
      </AppText>
    </View>
  );
}

function BarRow({
  label,
  ratio,
  color,
  value,
}: {
  label: string;
  ratio: number;
  color: string;
  value: string;
}) {
  const theme = useTheme();
  const width = `${Math.max(3, Math.min(100, ratio * 100))}%` as `${number}%`;
  return (
    <View style={styles.barRow}>
      <View style={styles.barLabels}>
        <AppText variant="label" numberOfLines={1} style={styles.barLabel}>
          {label}
        </AppText>
        <AppText variant="caption" muted>{value}</AppText>
      </View>
      <View style={[styles.barTrack, { backgroundColor: theme.surface }]}>
        <View style={[styles.barFill, { backgroundColor: color, width }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  content: {
    width: '100%',
    maxWidth: 900,
    alignSelf: 'center',
    padding: spacing.lg,
    paddingBottom: spacing.xxl,
    gap: spacing.xxl,
  },
  statGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  recap: {
    gap: spacing.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  recapCopy: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  stat: {
    width: '48%',
    minHeight: 108,
    flexGrow: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.lg,
    padding: spacing.md,
    justifyContent: 'space-between',
  },
  section: {
    gap: spacing.md,
  },
  sectionHeader: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  sectionCopy: {
    flex: 1,
    minWidth: 0,
  },
  yearControl: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  yearButton: {
    width: 40,
    height: 40,
    borderWidth: 1,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  yearLabel: {
    width: 48,
    textAlign: 'center',
  },
  heatmapScroll: {
    alignItems: 'flex-start',
    paddingBottom: spacing.sm,
  },
  weekdayLabels: {
    gap: HEATMAP_GAP,
    marginRight: spacing.sm,
  },
  weekdayLabel: {
    width: 12,
    height: HEATMAP_CELL,
    fontSize: 9,
    lineHeight: HEATMAP_CELL,
    textAlign: 'center',
  },
  heatmap: {
    flexDirection: 'row',
    gap: HEATMAP_GAP,
  },
  week: {
    gap: HEATMAP_GAP,
  },
  heatmapCell: {
    width: HEATMAP_CELL,
    height: HEATMAP_CELL,
    borderWidth: 1,
    borderRadius: 2,
  },
  heatmapPlaceholder: {
    opacity: 0,
  },
  heatmapFooter: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  legend: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  legendCell: {
    width: 12,
    height: 12,
    borderRadius: 2,
  },
  bars: {
    gap: spacing.lg,
  },
  barRow: {
    gap: spacing.sm,
  },
  barLabels: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  barLabel: {
    flex: 1,
    minWidth: 0,
  },
  barTrack: {
    height: 10,
    overflow: 'hidden',
    borderRadius: radius.sm,
  },
  barFill: {
    height: '100%',
    borderRadius: radius.sm,
  },
});
