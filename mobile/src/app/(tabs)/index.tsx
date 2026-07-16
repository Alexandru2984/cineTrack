import { router } from 'expo-router';
import { Clock3, Film, ListVideo, Search, Tv } from 'lucide-react-native';
import { useMemo } from 'react';
import {
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText } from '@/components/app-text';
import { EmptyState, ErrorState, LoadingState } from '@/components/screen-state';
import { EpisodeRow } from '@/components/episode-row';
import { MediaTile } from '@/components/media-tile';
import { ScreenHeader } from '@/components/screen-header';
import { radius, spacing } from '@/constants/theme';
import {
  useMarkCalendarEpisodeWatched,
  useSetEpisodePlanned,
  useUpNext,
} from '@/hooks/use-calendar';
import { useDiscovery } from '@/hooks/use-media';
import { useMyStats } from '@/hooks/use-stats';
import { useTheme } from '@/hooks/use-theme';
import { getErrorMessage } from '@/lib/http';
import { useAuthStore } from '@/store/auth';

export default function HomeScreen() {
  const theme = useTheme();
  const user = useAuthStore((state) => state.user);
  const upNext = useUpNext();
  const stats = useMyStats();
  const discovery = useDiscovery();
  const plan = useSetEpisodePlanned();
  const watched = useMarkCalendarEpisodeWatched();
  const refreshing = upNext.isRefetching || stats.isRefetching || discovery.isRefetching;
  const recommendations = useMemo(
    () => discovery.data?.recommendations.slice(0, 12) ?? [],
    [discovery.data],
  );

  const refresh = () => {
    void Promise.all([upNext.refetch(), stats.refetch(), discovery.refetch()]);
  };

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: theme.background }]} edges={['top']}>
      <ScrollView
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={refresh}
            tintColor={theme.primary}
            colors={[theme.primary]}
          />
        }
        contentContainerStyle={styles.content}
      >
        <ScreenHeader
          title={`Hello, ${user?.username || 'there'}`}
          subtitle="Your watching overview"
        />

        {stats.data ? (
          <View style={styles.stats}>
            <Stat icon={Film} label="Movies" value={stats.data.total_movies} />
            <Stat icon={Tv} label="Shows" value={stats.data.total_shows} />
            <Stat icon={Clock3} label="Hours" value={Math.round(stats.data.total_hours)} />
            <Stat icon={ListVideo} label="Episodes" value={stats.data.total_episodes} />
          </View>
        ) : null}

        <View style={styles.section}>
          <AppText variant="section">Up next</AppText>
          {upNext.isLoading ? (
            <LoadingState label="Loading your next episodes" />
          ) : upNext.isError ? (
            <ErrorState
              message={getErrorMessage(upNext.error, 'Your queue could not be loaded')}
              onRetry={() => void upNext.refetch()}
            />
          ) : upNext.data?.items.length ? (
            <View style={[styles.list, { borderTopColor: theme.border }]}>
              {upNext.data.items.map((item) => (
                <EpisodeRow
                  key={item.episode_id}
                  item={item}
                  onPlan={() =>
                    plan.mutate({
                      episodeId: item.episode_id,
                      planned: !item.is_planned,
                    })
                  }
                  onWatched={() => watched.mutate(item.episode_id)}
                  planPending={plan.isPending && plan.variables?.episodeId === item.episode_id}
                  watchedPending={watched.isPending && watched.variables === item.episode_id}
                />
              ))}
            </View>
          ) : (
            <EmptyState
              icon={Search}
              title="Nothing queued"
              message="Tracked shows with available unwatched episodes will appear here."
              actionLabel="Find a show"
              onAction={() => router.push('/(tabs)/search')}
            />
          )}
          {plan.error || watched.error ? (
            <AppText variant="caption" style={{ color: theme.danger }}>
              {getErrorMessage(plan.error || watched.error, 'The episode could not be updated')}
            </AppText>
          ) : null}
        </View>

        {recommendations.length ? (
          <View style={styles.section}>
            <AppText variant="section">
              {discovery.data?.personalized ? 'For you' : 'Discover'}
            </AppText>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.shelf}
            >
              {recommendations.map((item) => (
                <MediaTile key={`${item.id}-${item.media_type}`} item={item} width={132} />
              ))}
            </ScrollView>
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Film;
  label: string;
  value: number;
}) {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.stat,
        { backgroundColor: theme.surface, borderColor: theme.border },
      ]}
    >
      <Icon color={theme.info} size={19} />
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
    maxWidth: 900,
    alignSelf: 'center',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xxl,
    gap: spacing.xl,
  },
  stats: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  stat: {
    minWidth: '47%',
    flexGrow: 1,
    minHeight: 104,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.lg,
    padding: spacing.md,
    justifyContent: 'space-between',
  },
  section: {
    gap: spacing.md,
  },
  list: {
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  shelf: {
    gap: spacing.md,
    paddingRight: spacing.lg,
  },
});
