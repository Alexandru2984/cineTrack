import { Redirect, router } from 'expo-router';
import {
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Clapperboard,
  Film,
  Flame,
  Sparkles,
  Tv,
} from 'lucide-react-native';
import { useState } from 'react';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText } from '@/components/app-text';
import { Poster } from '@/components/poster';
import { EmptyState, ErrorState, LoadingState } from '@/components/screen-state';
import { radius, spacing } from '@/constants/theme';
import { useWrapped } from '@/hooks/use-stats';
import { useTheme } from '@/hooks/use-theme';
import { formatDate } from '@/lib/format';
import { hasLocalSession, useAuthStore } from '@/store/auth';
import type { WrappedStats } from '@/types';

const MONTH_LABELS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
const MIN_YEAR = 1900;

export default function WrappedScreen() {
  const theme = useTheme();
  const status = useAuthStore((state) => state.status);
  const hasSession = hasLocalSession(status);
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear);
  const recap = useWrapped(year, hasSession);

  if (!hasSession) return <Redirect href="/" />;

  return (
    <SafeAreaView
      style={[styles.safeArea, { backgroundColor: theme.background }]}
      edges={['bottom']}
    >
      <ScrollView
        refreshControl={
          <RefreshControl
            refreshing={recap.isRefetching}
            onRefresh={() => void recap.refetch()}
            tintColor={theme.primary}
            colors={[theme.primary]}
          />
        }
        contentContainerStyle={styles.content}
      >
        <View style={[styles.hero, { backgroundColor: theme.primary }]}>
          <View style={styles.heroTitle}>
            <Sparkles color="#FFFFFF" size={19} />
            <AppText variant="label" style={styles.heroCopy}>
              Your year in review
            </AppText>
          </View>
          <View style={styles.yearRow}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Previous recap year"
              disabled={year <= MIN_YEAR || recap.isFetching}
              onPress={() => setYear((value) => Math.max(MIN_YEAR, value - 1))}
              style={({ pressed }) => [
                styles.yearButton,
                {
                  borderColor: 'rgba(255,255,255,0.55)',
                  opacity: year <= MIN_YEAR || recap.isFetching ? 0.4 : pressed ? 0.7 : 1,
                },
              ]}
            >
              <ChevronLeft color="#FFFFFF" size={21} />
            </Pressable>
            <AppText variant="title" style={styles.heroYear}>
              {year}
            </AppText>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Next recap year"
              disabled={year >= currentYear || recap.isFetching}
              onPress={() => setYear((value) => Math.min(currentYear, value + 1))}
              style={({ pressed }) => [
                styles.yearButton,
                {
                  borderColor: 'rgba(255,255,255,0.55)',
                  opacity: year >= currentYear || recap.isFetching ? 0.4 : pressed ? 0.7 : 1,
                },
              ]}
            >
              <ChevronRight color="#FFFFFF" size={21} />
            </Pressable>
          </View>
        </View>

        {recap.isLoading ? (
          <LoadingState label="Building your recap" />
        ) : recap.isError || !recap.data ? (
          <ErrorState
            message="Your annual recap could not be loaded"
            onRetry={() => void recap.refetch()}
          />
        ) : recap.data.total_watches === 0 ? (
          <EmptyState
            icon={Clapperboard}
            title={`No watch history for ${year}`}
            message="Watch events from this year will appear here."
            actionLabel="Open statistics"
            onAction={() => router.replace('/statistics')}
          />
        ) : (
          <Recap data={recap.data} />
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Recap({ data }: { data: WrappedStats }) {
  const theme = useTheme();
  const maxGenre = Math.max(1, ...data.top_genres.map((entry) => entry.count));
  const maxMonth = Math.max(1, ...data.monthly.map((entry) => entry.count));

  return (
    <>
      <View style={styles.statGrid}>
        <StatTile icon={Sparkles} label="Titles" value={data.distinct_titles} />
        <StatTile icon={Clock3} label="Hours" value={Math.round(data.total_hours)} />
        <StatTile icon={Clapperboard} label="Total plays" value={data.total_watches} />
        <StatTile icon={Film} label="Movies" value={data.movies_watched} />
        <StatTile icon={Tv} label="Episodes" value={data.episodes_watched} />
        <StatTile icon={Flame} label="Best streak" value={`${data.longest_streak}d`} />
      </View>

      {data.first_watch && data.last_watch ? (
        <View style={styles.dateRange}>
          <CalendarRange color={theme.mutedText} size={18} />
          <AppText muted style={styles.dateRangeCopy}>
            From {formatDate(data.first_watch)} to {formatDate(data.last_watch)}
          </AppText>
        </View>
      ) : null}

      {data.top_shows.length > 0 ? (
        <View style={styles.section}>
          <AppText variant="section">Most watched</AppText>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.titles}
          >
            {data.top_shows.map((title) => (
              <Pressable
                key={`${title.media_type}:${title.tmdb_id}`}
                accessibilityRole="button"
                accessibilityLabel={`Open ${title.title}, ${title.count} ${
                  title.count === 1 ? 'play' : 'plays'
                }`}
                onPress={() =>
                  router.push({
                    pathname: '/media/[id]',
                    params: {
                      id: String(title.tmdb_id),
                      type: title.media_type,
                    },
                  })
                }
                style={({ pressed }) => [
                  styles.titleCard,
                  { opacity: pressed ? 0.7 : 1 },
                ]}
              >
                <Poster path={title.poster_path} width={112} height={168} />
                <AppText variant="label" numberOfLines={2}>
                  {title.title}
                </AppText>
                <AppText variant="caption" muted>
                  {title.count} {title.count === 1 ? 'play' : 'plays'}
                </AppText>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      ) : null}

      {data.top_genres.length > 0 ? (
        <View style={styles.section}>
          <AppText variant="section">Top genres</AppText>
          <View style={styles.genreList}>
            {data.top_genres.map((genre) => (
              <View key={genre.genre} style={styles.genre}>
                <View style={styles.genreLabels}>
                  <AppText variant="label">{genre.genre}</AppText>
                  <AppText variant="caption" muted>
                    {genre.count}
                  </AppText>
                </View>
                <View style={[styles.genreTrack, { backgroundColor: theme.surface }]}>
                  <View
                    style={[
                      styles.genreFill,
                      {
                        backgroundColor: theme.primary,
                        width: `${Math.max(3, (genre.count / maxGenre) * 100)}%`,
                      },
                    ]}
                  />
                </View>
              </View>
            ))}
          </View>
        </View>
      ) : null}

      <View style={styles.section}>
        <AppText variant="section">By month</AppText>
        <View style={styles.months}>
          {data.monthly.map((month, index) => (
            <View
              key={month.month}
              accessible
              accessibilityLabel={`${month.count} ${
                month.count === 1 ? 'watch' : 'watches'
              } in month ${month.month}`}
              style={styles.month}
            >
              <View style={styles.monthTrack}>
                <View
                  style={[
                    styles.monthFill,
                    {
                      backgroundColor: theme.primary,
                      height: `${(month.count / maxMonth) * 100}%`,
                    },
                  ]}
                />
              </View>
              <AppText variant="caption" muted style={styles.monthLabel}>
                {MONTH_LABELS[index]}
              </AppText>
            </View>
          ))}
        </View>
      </View>
    </>
  );
}

function StatTile({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Film;
  label: string;
  value: string | number;
}) {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.stat,
        { backgroundColor: theme.elevated, borderColor: theme.border },
      ]}
    >
      <Icon color={theme.primary} size={20} />
      <AppText variant="section">{value}</AppText>
      <AppText variant="caption" muted>
        {label}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  content: {
    width: '100%',
    maxWidth: 760,
    alignSelf: 'center',
    padding: spacing.lg,
    paddingBottom: spacing.xxl,
    gap: spacing.xxl,
  },
  hero: {
    gap: spacing.lg,
    borderRadius: radius.lg,
    padding: spacing.xl,
  },
  heroTitle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  heroCopy: {
    color: '#FFFFFF',
  },
  yearRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  yearButton: {
    width: 44,
    height: 44,
    borderWidth: 1,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroYear: {
    color: '#FFFFFF',
  },
  statGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  stat: {
    width: '48%',
    minHeight: 106,
    flexGrow: 1,
    justifyContent: 'space-between',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.lg,
    padding: spacing.md,
  },
  dateRange: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  dateRangeCopy: {
    flex: 1,
    minWidth: 0,
  },
  section: {
    gap: spacing.md,
  },
  titles: {
    gap: spacing.md,
    paddingBottom: spacing.xs,
  },
  titleCard: {
    width: 112,
    gap: spacing.xs,
  },
  genreList: {
    gap: spacing.lg,
  },
  genre: {
    gap: spacing.sm,
  },
  genreLabels: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  genreTrack: {
    height: 10,
    overflow: 'hidden',
    borderRadius: radius.sm,
  },
  genreFill: {
    height: '100%',
    borderRadius: radius.sm,
  },
  months: {
    height: 132,
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.xs,
  },
  month: {
    height: '100%',
    flex: 1,
    alignItems: 'center',
    gap: spacing.xs,
  },
  monthTrack: {
    width: '100%',
    flex: 1,
    justifyContent: 'flex-end',
  },
  monthFill: {
    width: '100%',
    minHeight: 2,
    borderTopLeftRadius: radius.sm,
    borderTopRightRadius: radius.sm,
  },
  monthLabel: {
    fontSize: 10,
  },
});
