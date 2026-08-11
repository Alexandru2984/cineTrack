import { router } from 'expo-router';
import {
  Bell,
  ChevronRight,
  Clock3,
  Film,
  ListVideo,
  Search,
  Settings2,
  Tv,
  UploadCloud,
  type LucideIcon,
} from 'lucide-react-native';
import { useMemo } from 'react';
import {
  RefreshControl,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText } from '@/components/app-text';
import { EmptyState, ErrorState, LoadingState } from '@/components/screen-state';
import { EpisodeRow } from '@/components/episode-row';
import { MediaTile } from '@/components/media-tile';
import { Poster } from '@/components/poster';
import { ScreenHeader } from '@/components/screen-header';
import { radius, spacing } from '@/constants/theme';
import {
  useMarkCalendarEpisodeWatched,
  useSetEpisodePlanned,
  useUpNext,
} from '@/hooks/use-calendar';
import { useDiscovery } from '@/hooks/use-media';
import { useNotificationSummary } from '@/hooks/use-notifications';
import { useMyStats } from '@/hooks/use-stats';
import { useT } from '@/hooks/use-t';
import { useTheme } from '@/hooks/use-theme';
import { useWatchlistPreview } from '@/hooks/use-tracking';
import { getErrorMessage } from '@/lib/http';
import { elapsedSince, groupUpNext } from '@/lib/up-next';
import { useAuthStore } from '@/store/auth';
import type { TrackingItem } from '@/types';

type Translate = ReturnType<typeof useT>;

/** Maps the pure elapsed descriptor to a localized "N days ago" style label. */
function formatElapsed(t: Translate, value: string): string {
  const elapsed = elapsedSince(value);
  switch (elapsed.unit) {
    case 'days':
      return t('upNext.daysAgo', { count: elapsed.count });
    case 'months':
      return t('upNext.monthsAgo', { count: elapsed.count });
    case 'aYear':
      return t('upNext.aYearAgo');
    case 'years':
      return t('upNext.yearsAgo', { count: elapsed.count });
  }
}

export default function HomeScreen() {
  const theme = useTheme();
  const t = useT();
  const user = useAuthStore((state) => state.user);
  const upNext = useUpNext();
  const stats = useMyStats();
  const discovery = useDiscovery();
  const watchlist = useWatchlistPreview();
  const notificationSummary = useNotificationSummary();
  const plan = useSetEpisodePlanned();
  const watched = useMarkCalendarEpisodeWatched();
  const refreshing =
    upNext.isRefetching ||
    stats.isRefetching ||
    watchlist.isRefetching ||
    discovery.isRefetching;
  const unreadCount = notificationSummary.data?.unread_count ?? 0;
  const recommendations = useMemo(
    () => discovery.data?.recommendations.slice(0, 12) ?? [],
    [discovery.data],
  );
  const becauseYouWatched = discovery.data?.because_you_watched ?? null;
  const upNextGroups = useMemo(
    () => groupUpNext(upNext.data?.items ?? []),
    [upNext.data],
  );

  const watchlistItems = watchlist.data ?? [];

  const refresh = () => {
    void Promise.all([
      upNext.refetch(),
      stats.refetch(),
      discovery.refetch(),
      watchlist.refetch(),
      notificationSummary.refetch(),
    ]);
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
          title={t('home.greeting', { name: user?.username || t('home.greetingFallback') })}
          subtitle={t('home.overview')}
          right={
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                unreadCount
                  ? t('home.openNotificationsUnread', { count: unreadCount })
                  : t('home.openNotifications')
              }
              onPress={() => router.push('/notifications')}
              style={({ pressed }) => [
                styles.notificationButton,
                {
                  borderColor: theme.border,
                  backgroundColor: theme.elevated,
                  opacity: pressed ? 0.72 : 1,
                },
              ]}
            >
              <Bell color={theme.mutedText} size={21} />
              {unreadCount > 0 ? (
                <View style={[styles.notificationBadge, { backgroundColor: theme.danger }]}>
                  <AppText variant="caption" style={styles.notificationBadgeText}>
                    {unreadCount > 99 ? '99+' : unreadCount}
                  </AppText>
                </View>
              ) : null}
            </Pressable>
          }
        />

        {stats.data &&
        stats.data.total_movies === 0 &&
        stats.data.total_shows === 0 ? (
          <View
            style={[
              styles.onboarding,
              { borderColor: theme.border, backgroundColor: theme.elevated },
            ]}
          >
            <View style={styles.onboardingCopy}>
              <AppText variant="section">{t('home.onboardingTitle')}</AppText>
              <AppText variant="caption" muted>
                {t('home.onboardingSubtitle')}
              </AppText>
            </View>
            <OnboardingAction
              icon={Search}
              label={t('home.onboardingSearch')}
              onPress={() => router.push('/(tabs)/search')}
            />
            <OnboardingAction
              icon={UploadCloud}
              label={t('home.onboardingImport')}
              onPress={() => router.push('/import-tvtime')}
            />
            <OnboardingAction
              icon={Settings2}
              label={t('home.onboardingSettings')}
              onPress={() => router.push('/settings')}
            />
          </View>
        ) : null}

        {stats.data ? (
          <View style={styles.stats}>
            <Stat icon={Film} label={t('home.movies')} value={stats.data.total_movies} />
            <Stat icon={Tv} label={t('home.shows')} value={stats.data.total_shows} />
            <Stat icon={Clock3} label={t('home.hours')} value={Math.round(stats.data.total_hours)} />
            <Stat icon={ListVideo} label={t('home.episodes')} value={stats.data.total_episodes} />
          </View>
        ) : null}

        <View style={styles.section}>
          <AppText variant="section">{t('upNext.title')}</AppText>
          {upNext.isLoading ? (
            <LoadingState label={t('upNext.loading')} />
          ) : upNext.isError ? (
            <ErrorState
              message={getErrorMessage(upNext.error, t('upNext.loadError'))}
              onRetry={() => void upNext.refetch()}
            />
          ) : upNextGroups.length ? (
            upNextGroups.map((group) => (
              <View key={group.key} style={styles.upNextGroup}>
                {upNextGroups.length > 1 ? (
                  <AppText variant="caption" muted>
                    {t(group.titleKey).toUpperCase()}
                  </AppText>
                ) : null}
                <View style={[styles.list, { borderTopColor: theme.border }]}>
                  {group.items.map((item) => (
                    <EpisodeRow
                      key={item.episode_id}
                      item={item}
                      note={
                        group.key === 'dormant'
                          ? t('upNext.watchedAgo', {
                              when: formatElapsed(t, item.last_watched_at),
                            })
                          : undefined
                      }
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
              </View>
            ))
          ) : (
            <EmptyState
              icon={Search}
              title={t('upNext.emptyTitle')}
              message={t('upNext.emptyMessage')}
              actionLabel={t('upNext.findShow')}
              onAction={() => router.push('/(tabs)/search')}
            />
          )}
          {plan.error || watched.error ? (
            <AppText variant="caption" style={{ color: theme.danger }}>
              {getErrorMessage(plan.error || watched.error, t('upNext.updateError'))}
            </AppText>
          ) : null}
        </View>

        {/*
          Up next only covers shows already in progress, so a title someone
          saved to watch later surfaced nowhere on this screen — not the movies,
          which are never episodes, and not the shows with no history yet. A
          tester reported exactly that: "is it possible to remember the what to
          watch list?". It always was, under a filter chip in the library.
        */}
        {watchlistItems.length ? (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <AppText variant="section">{t('watchlist.title')}</AppText>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('watchlist.seeAllLabel')}
                onPress={() =>
                  router.navigate({
                    pathname: '/(tabs)/library',
                    params: { status: 'plan_to_watch' },
                  })
                }
                hitSlop={8}
                style={({ pressed }) => [styles.seeAll, { opacity: pressed ? 0.7 : 1 }]}
              >
                <AppText variant="label" style={{ color: theme.primary }}>
                  {t('watchlist.seeAll')}
                </AppText>
                <ChevronRight color={theme.primary} size={16} />
              </Pressable>
            </View>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.shelf}
            >
              {watchlistItems.map((item) => (
                <WatchlistTile key={item.id} item={item} />
              ))}
            </ScrollView>
          </View>
        ) : null}

        {becauseYouWatched && becauseYouWatched.results.length ? (
          <View style={styles.section}>
            <AppText variant="section">
              {t('home.becauseYouWatched', { title: becauseYouWatched.seed_title })}
            </AppText>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.shelf}
            >
              {becauseYouWatched.results.map((item) => (
                <MediaTile key={`byw-${item.id}-${item.media_type}`} item={item} width={132} />
              ))}
            </ScrollView>
          </View>
        ) : null}

        {recommendations.length ? (
          <View style={styles.section}>
            <AppText variant="section">
              {discovery.data?.personalized ? t('home.forYou') : t('home.discover')}
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

/**
 * A saved title has no TMDB payload behind it, only the tracking row, so this
 * cannot reuse `MediaTile`. It matches its width to sit in the same shelf.
 */
function WatchlistTile({ item }: { item: TrackingItem }) {
  const t = useT();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('mediaCard.open', { title: item.title })}
      onPress={() =>
        router.push({
          pathname: '/media/[id]',
          params: { id: String(item.tmdb_id), type: item.media_type },
        })
      }
      style={({ pressed }) => [styles.watchlistTile, { opacity: pressed ? 0.78 : 1 }]}
    >
      <Poster path={item.poster_path} width={132} height={198} />
      <AppText variant="label" numberOfLines={2} style={styles.watchlistTitle}>
        {item.title}
      </AppText>
      <AppText variant="caption" muted numberOfLines={1}>
        {t(item.media_type === 'tv' ? 'mediaType.tv' : 'mediaType.movie')}
      </AppText>
    </Pressable>
  );
}

function OnboardingAction({
  icon: Icon,
  label,
  onPress,
}: {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.onboardingAction,
        {
          borderTopColor: theme.border,
          opacity: pressed ? 0.7 : 1,
        },
      ]}
    >
      <Icon color={theme.primary} size={19} />
      <AppText variant="label" style={styles.onboardingActionCopy}>
        {label}
      </AppText>
    </Pressable>
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
  onboarding: {
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.lg,
  },
  onboardingCopy: {
    gap: spacing.xs,
    paddingVertical: spacing.lg,
  },
  onboardingAction: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  onboardingActionCopy: {
    flex: 1,
  },
  stats: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  notificationButton: {
    width: 46,
    height: 46,
    borderWidth: 1,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  notificationBadge: {
    position: 'absolute',
    top: -5,
    right: -5,
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    paddingHorizontal: spacing.xs,
    alignItems: 'center',
    justifyContent: 'center',
  },
  notificationBadgeText: {
    color: '#FFFFFF',
    fontSize: 10,
    lineHeight: 12,
    fontWeight: '700',
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
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  seeAll: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    minHeight: 32,
  },
  watchlistTile: {
    width: 132,
  },
  watchlistTitle: {
    marginTop: spacing.sm,
    minHeight: 40,
  },
  upNextGroup: {
    gap: spacing.xs,
  },
  list: {
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  shelf: {
    gap: spacing.md,
    paddingRight: spacing.lg,
  },
});
