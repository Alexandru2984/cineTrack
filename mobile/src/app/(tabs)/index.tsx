import { router } from 'expo-router';
import {
  Bell,
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
import { useTheme } from '@/hooks/use-theme';
import { getErrorMessage } from '@/lib/http';
import { groupUpNext, lastWatchedLabel } from '@/lib/up-next';
import { useAuthStore } from '@/store/auth';

export default function HomeScreen() {
  const theme = useTheme();
  const user = useAuthStore((state) => state.user);
  const upNext = useUpNext();
  const stats = useMyStats();
  const discovery = useDiscovery();
  const notificationSummary = useNotificationSummary();
  const plan = useSetEpisodePlanned();
  const watched = useMarkCalendarEpisodeWatched();
  const refreshing =
    upNext.isRefetching ||
    stats.isRefetching ||
    discovery.isRefetching;
  const unreadCount = notificationSummary.data?.unread_count ?? 0;
  const recommendations = useMemo(
    () => discovery.data?.recommendations.slice(0, 12) ?? [],
    [discovery.data],
  );
  const upNextGroups = useMemo(
    () => groupUpNext(upNext.data?.items ?? []),
    [upNext.data],
  );

  const refresh = () => {
    void Promise.all([
      upNext.refetch(),
      stats.refetch(),
      discovery.refetch(),
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
          title={`Hello, ${user?.username || 'there'}`}
          subtitle="Your watching overview"
          right={
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Open notifications${
                unreadCount
                  ? `, ${unreadCount} unread`
                  : ''
              }`}
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
              <AppText variant="section">Make Văzute yours</AppText>
              <AppText variant="caption" muted>
                Add a first title or bring your existing TV Time history.
              </AppText>
            </View>
            <OnboardingAction
              icon={Search}
              label="Find your first movie or show"
              onPress={() => router.push('/(tabs)/search')}
            />
            <OnboardingAction
              icon={UploadCloud}
              label="Import from TV Time"
              onPress={() => router.push('/import-tvtime')}
            />
            <OnboardingAction
              icon={Settings2}
              label="Set your region and release alerts"
              onPress={() => router.push('/settings')}
            />
          </View>
        ) : null}

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
          ) : upNextGroups.length ? (
            upNextGroups.map((group) => (
              <View key={group.key} style={styles.upNextGroup}>
                {upNextGroups.length > 1 ? (
                  <AppText variant="caption" muted>
                    {group.title.toUpperCase()}
                  </AppText>
                ) : null}
                <View style={[styles.list, { borderTopColor: theme.border }]}>
                  {group.items.map((item) => (
                    <EpisodeRow
                      key={item.episode_id}
                      item={item}
                      note={
                        group.key === 'dormant'
                          ? `watched ${lastWatchedLabel(item.last_watched_at)}`
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
