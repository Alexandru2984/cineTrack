import { router } from 'expo-router';
import {
  Bookmark,
  BookmarkCheck,
  CalendarDays,
  Film,
  LoaderCircle,
} from 'lucide-react-native';
import { useMemo, useState } from 'react';
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Switch,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText } from '@/components/app-text';
import { EpisodeRow } from '@/components/episode-row';
import { Poster } from '@/components/poster';
import { ScreenHeader } from '@/components/screen-header';
import { EmptyState, ErrorState, LoadingState } from '@/components/screen-state';
import { SegmentedControl } from '@/components/segmented-control';
import { radius, spacing } from '@/constants/theme';
import {
  useCalendarSummary,
  useMarkCalendarEpisodeWatched,
  useNewEpisodes,
  useSetEpisodePlanned,
  useUpcoming,
} from '@/hooks/use-calendar';
import { useTheme } from '@/hooks/use-theme';
import { episodeCode, formatDate } from '@/lib/format';
import { getErrorMessage } from '@/lib/http';
import type { CalendarEpisode, UpcomingCalendarItem } from '@/types';

type CalendarView = 'new' | 'upcoming';
type UpcomingFilter = 'all' | 'tv' | 'movie';
type CalendarListItem =
  | { kind: 'new'; item: CalendarEpisode }
  | { kind: 'upcoming'; item: UpcomingCalendarItem };

const viewOptions = [
  { value: 'new', label: 'New episodes' },
  { value: 'upcoming', label: 'Upcoming' },
] as const;

const filterOptions = [
  { value: 'all', label: 'All' },
  { value: 'tv', label: 'TV shows' },
  { value: 'movie', label: 'Movies' },
] as const;

export default function CalendarScreen() {
  const theme = useTheme();
  const [view, setView] = useState<CalendarView>('new');
  const [filter, setFilter] = useState<UpcomingFilter>('all');
  const [includeSpecials, setIncludeSpecials] = useState(false);
  const summary = useCalendarSummary();
  const newEpisodes = useNewEpisodes(includeSpecials, view === 'new');
  const upcoming = useUpcoming(filter, includeSpecials, view === 'upcoming');
  const plan = useSetEpisodePlanned();
  const watched = useMarkCalendarEpisodeWatched();

  const newItems = useMemo(() => {
    const items = newEpisodes.data?.pages.flatMap((page) => page.items) ?? [];
    return Array.from(new Map(items.map((item) => [item.episode_id, item])).values());
  }, [newEpisodes.data]);
  const upcomingItems = useMemo(() => {
    const items = upcoming.data?.pages.flatMap((page) => page.items) ?? [];
    return Array.from(
      new Map(
        items.map((item) => [
          `${item.item_kind}:${item.item_id}:${item.release_type ?? 'default'}`,
          item,
        ]),
      ).values(),
    );
  }, [upcoming.data]);
  const data: CalendarListItem[] =
    view === 'new'
      ? newItems.map((item) => ({ kind: 'new', item }))
      : upcomingItems.map((item) => ({ kind: 'upcoming', item }));
  const activeQuery = view === 'new' ? newEpisodes : upcoming;
  const region = upcoming.data?.pages[0]?.country_code;
  const actionError = plan.error || watched.error;

  const refresh = () => {
    void Promise.all([activeQuery.refetch(), summary.refetch()]);
  };

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: theme.background }]} edges={['top']}>
      <FlatList
        data={data}
        keyExtractor={(entry) =>
          entry.kind === 'new'
            ? entry.item.episode_id
            : `${entry.item.item_kind}:${entry.item.item_id}:${entry.item.release_type ?? 'default'}`
        }
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={activeQuery.isRefetching && !activeQuery.isFetchingNextPage}
            onRefresh={refresh}
            tintColor={theme.primary}
            colors={[theme.primary]}
          />
        }
        onEndReached={() => {
          if (activeQuery.hasNextPage && !activeQuery.isFetchingNextPage) {
            void activeQuery.fetchNextPage();
          }
        }}
        onEndReachedThreshold={0.5}
        ListHeaderComponent={
          <View style={styles.header}>
            <ScreenHeader
              title="Calendar"
              subtitle={
                summary.data
                  ? `${summary.data.new_count} unwatched · ${summary.data.planned_count} planned`
                  : 'Releases from your library'
              }
            />
            <SegmentedControl value={view} options={viewOptions} onChange={setView} />
            {view === 'upcoming' ? (
              <SegmentedControl value={filter} options={filterOptions} onChange={setFilter} />
            ) : null}
            <View style={[styles.switchRow, { borderColor: theme.border }]}>
              <View style={styles.switchCopy}>
                <AppText variant="label">Special episodes</AppText>
                <AppText variant="caption" muted>
                  Include season 0
                </AppText>
              </View>
              <Switch
                value={includeSpecials}
                onValueChange={setIncludeSpecials}
                trackColor={{ false: theme.border, true: theme.primarySoft }}
                thumbColor={includeSpecials ? theme.primary : theme.mutedText}
              />
            </View>
            {region && view === 'upcoming' ? (
              <AppText variant="caption" muted>
                Movie release region: {region}
              </AppText>
            ) : null}
            {actionError ? (
              <AppText variant="caption" style={{ color: theme.danger }}>
                {getErrorMessage(actionError, 'The calendar item could not be updated')}
              </AppText>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          activeQuery.isLoading ? (
            <LoadingState label={view === 'new' ? 'Loading new episodes' : 'Loading releases'} />
          ) : activeQuery.isError ? (
            <ErrorState
              message={getErrorMessage(activeQuery.error, 'The calendar could not be loaded')}
              onRetry={() => void activeQuery.refetch()}
            />
          ) : (
            <EmptyState
              icon={CalendarDays}
              title={view === 'new' ? 'You are caught up' : 'No upcoming releases'}
              message={
                view === 'new'
                  ? 'There are no available unwatched episodes in this view.'
                  : 'Tracked releases will appear here when dates are available.'
              }
            />
          )
        }
        ListFooterComponent={
          activeQuery.isFetchingNextPage ? <LoadingState label="Loading more" /> : null
        }
        renderItem={({ item: entry }) =>
          entry.kind === 'new' ? (
            <EpisodeRow
              item={entry.item}
              onPlan={() =>
                plan.mutate({
                  episodeId: entry.item.episode_id,
                  planned: !entry.item.is_planned,
                })
              }
              onWatched={() => watched.mutate(entry.item.episode_id)}
              planPending={
                plan.isPending && plan.variables?.episodeId === entry.item.episode_id
              }
              watchedPending={
                watched.isPending && watched.variables === entry.item.episode_id
              }
            />
          ) : (
            <UpcomingRow
              item={entry.item}
              onPlan={() =>
                plan.mutate({
                  episodeId: entry.item.item_id,
                  planned: !entry.item.is_planned,
                })
              }
              pending={plan.isPending && plan.variables?.episodeId === entry.item.item_id}
            />
          )
        }
      />
    </SafeAreaView>
  );
}

const releaseLabels: Record<number, string> = {
  1: 'Premiere',
  2: 'Limited cinema',
  3: 'Cinema',
  4: 'Digital',
  5: 'Physical',
  6: 'TV',
};

function UpcomingRow({
  item,
  onPlan,
  pending,
}: {
  item: UpcomingCalendarItem;
  onPlan: () => void;
  pending: boolean;
}) {
  const theme = useTheme();
  const isEpisode = item.item_kind === 'episode';
  return (
    <View style={[styles.upcomingRow, { borderBottomColor: theme.border }]}>
      <Pressable
        style={({ pressed }) => [styles.upcomingDetails, { opacity: pressed ? 0.72 : 1 }]}
        onPress={() =>
          isEpisode
            ? router.push({ pathname: '/episodes/[id]', params: { id: item.item_id } })
            : router.push({
                pathname: '/media/[id]',
                params: { id: String(item.tmdb_id), type: 'movie' },
              })
        }
      >
        <Poster path={item.poster_path} width={50} height={75} />
        <View style={styles.upcomingCopy}>
          <AppText variant="label" numberOfLines={1}>
            {item.title}
          </AppText>
          <AppText numberOfLines={1}>
            {isEpisode
              ? `${episodeCode(item.season_number ?? 0, item.episode_number ?? 0)} ${
                  item.episode_name || ''
                }`
              : item.release_type
                ? releaseLabels[item.release_type] || 'Release'
                : 'Release'}
          </AppText>
          <AppText variant="caption" muted>
            {formatDate(item.release_date, true)}
          </AppText>
        </View>
      </Pressable>
      {isEpisode ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={item.is_planned ? 'Remove from Watch next' : 'Add to Watch next'}
          disabled={pending}
          onPress={onPlan}
          style={({ pressed }) => [
            styles.calendarIconButton,
            {
              borderColor: item.is_planned ? theme.warning : theme.border,
              backgroundColor: item.is_planned ? theme.warningSoft : theme.elevated,
              opacity: pending ? 0.5 : pressed ? 0.72 : 1,
            },
          ]}
        >
          {pending ? (
            <LoaderCircle color={theme.warning} size={18} />
          ) : item.is_planned ? (
            <BookmarkCheck color={theme.warning} size={18} />
          ) : (
            <Bookmark color={theme.mutedText} size={18} />
          )}
        </Pressable>
      ) : (
        <View style={[styles.movieIcon, { backgroundColor: theme.infoSoft }]}>
          <Film color={theme.info} size={18} />
        </View>
      )}
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
  },
  header: {
    gap: spacing.lg,
    paddingBottom: spacing.lg,
  },
  switchRow: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: spacing.sm,
  },
  switchCopy: {
    gap: spacing.xs,
  },
  upcomingRow: {
    minHeight: 100,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: spacing.md,
  },
  upcomingDetails: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  upcomingCopy: {
    flex: 1,
    minWidth: 0,
    gap: spacing.xs,
  },
  calendarIconButton: {
    width: 42,
    height: 42,
    borderWidth: 1,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  movieIcon: {
    width: 42,
    height: 42,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
