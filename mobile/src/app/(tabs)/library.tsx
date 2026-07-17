import { router } from 'expo-router';
import {
  Check,
  Heart,
  SlidersHorizontal,
  Star,
  Trash2,
} from 'lucide-react-native';
import { useState } from 'react';
import {
  Alert,
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppButton } from '@/components/app-button';
import { AppText } from '@/components/app-text';
import { Poster } from '@/components/poster';
import { ScreenHeader } from '@/components/screen-header';
import { EmptyState, ErrorState, LoadingState } from '@/components/screen-state';
import { SegmentedControl } from '@/components/segmented-control';
import { TrackingFeedbackSheet } from '@/components/tracking-feedback-sheet';
import { radius, spacing } from '@/constants/theme';
import {
  useDeleteTracking,
  useTrackingInfinite,
  useUpdateTracking,
} from '@/hooks/use-tracking';
import { useTheme } from '@/hooks/use-theme';
import { trackingStatusLabels } from '@/lib/format';
import { getErrorMessage } from '@/lib/http';
import type { TrackingItem, TrackingStatus } from '@/types';

type LibraryFilter = 'all' | TrackingStatus;

const filterOptions = [
  { value: 'all', label: 'All' },
  { value: 'watching', label: 'Watching' },
  { value: 'plan_to_watch', label: 'Plan to watch' },
  { value: 'completed', label: 'Completed' },
  { value: 'on_hold', label: 'On hold' },
  { value: 'dropped', label: 'Dropped' },
] as const;

const statusOptions = filterOptions.slice(1) as readonly {
  value: TrackingStatus;
  label: string;
}[];

export default function LibraryScreen() {
  const theme = useTheme();
  const [filter, setFilter] = useState<LibraryFilter>('all');
  const [statusItem, setStatusItem] = useState<TrackingItem | null>(null);
  const [feedbackItem, setFeedbackItem] = useState<TrackingItem | null>(null);
  const tracking = useTrackingInfinite(filter === 'all' ? undefined : filter);
  const update = useUpdateTracking();
  const remove = useDeleteTracking();
  const mutationError = update.error || remove.error;
  const items = tracking.data?.pages.flatMap((page) => page) ?? [];

  const confirmRemove = (item: TrackingItem) => {
    Alert.alert('Remove from library?', item.title, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => remove.mutate(item.id),
      },
    ]);
  };

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: theme.background }]} edges={['top']}>
      <FlatList
        data={items}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={tracking.isRefetching && !tracking.isFetchingNextPage}
            onRefresh={() => void tracking.refetch()}
            tintColor={theme.primary}
            colors={[theme.primary]}
          />
        }
        onEndReached={() => {
          if (tracking.hasNextPage && !tracking.isFetchingNextPage) {
            void tracking.fetchNextPage();
          }
        }}
        onEndReachedThreshold={0.5}
        ListHeaderComponent={
          <View style={styles.header}>
            <ScreenHeader
              title="Library"
              subtitle={
                tracking.data
                  ? `${items.length}${tracking.hasNextPage ? '+' : ''} ${
                      items.length === 1 ? 'title' : 'titles'
                    }`
                  : 'Your tracked titles'
              }
            />
            <SegmentedControl value={filter} options={filterOptions} onChange={setFilter} />
            {mutationError ? (
              <AppText variant="caption" style={{ color: theme.danger }}>
                {getErrorMessage(mutationError, 'The library could not be updated')}
              </AppText>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          tracking.isLoading ? (
            <LoadingState label="Loading your library" />
          ) : tracking.isError ? (
            <ErrorState
              message={getErrorMessage(tracking.error, 'Your library could not be loaded')}
              onRetry={() => void tracking.refetch()}
            />
          ) : (
            <EmptyState
              icon={SlidersHorizontal}
              title="No titles here"
              message="Change the filter or add a title from Search."
            />
          )
        }
        ListFooterComponent={
          tracking.isFetchingNextPage ? <LoadingState label="Loading more" /> : null
        }
        renderItem={({ item }) => (
          <View style={[styles.row, { borderBottomColor: theme.border }]}>
            <Pressable
              onPress={() =>
                router.push({
                  pathname: '/media/[id]',
                  params: { id: String(item.tmdb_id), type: item.media_type },
                })
              }
              style={({ pressed }) => [
                styles.mainRow,
                { opacity: pressed ? 0.72 : 1 },
              ]}
            >
              <Poster path={item.poster_path} width={54} height={81} />
              <View style={styles.copy}>
                <AppText variant="label" numberOfLines={2}>
                  {item.title}
                </AppText>
                <AppText variant="caption" muted>
                  {item.media_type === 'tv' ? 'TV show' : 'Movie'}
                </AppText>
                {item.rating ? (
                  <AppText variant="caption" style={{ color: theme.warning }}>
                    {item.rating}/10
                  </AppText>
                ) : null}
              </View>
            </Pressable>
            <View style={styles.actions}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Edit rating and review for ${item.title}`}
                onPress={() => {
                  update.reset();
                  setFeedbackItem(item);
                }}
                style={[styles.iconButton, { borderColor: theme.border }]}
              >
                <Star
                  color={item.rating ? theme.warning : theme.mutedText}
                  fill={item.rating ? theme.warning : 'transparent'}
                  size={18}
                />
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Change status for ${item.title}`}
                onPress={() => setStatusItem(item)}
                style={({ pressed }) => [
                  styles.statusButton,
                  {
                    borderColor: theme.border,
                    backgroundColor: theme.elevated,
                    opacity: pressed ? 0.72 : 1,
                  },
                ]}
              >
                <SlidersHorizontal color={theme.mutedText} size={16} />
                <AppText variant="caption" numberOfLines={1}>
                  {trackingStatusLabels[item.status]}
                </AppText>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={
                  item.is_favorite ? `Remove ${item.title} from favorites` : `Favorite ${item.title}`
                }
                onPress={() =>
                  update.mutate({ id: item.id, is_favorite: !item.is_favorite })
                }
                style={[styles.iconButton, { borderColor: theme.border }]}
              >
                <Heart
                  color={item.is_favorite ? theme.danger : theme.mutedText}
                  fill={item.is_favorite ? theme.danger : 'transparent'}
                  size={18}
                />
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Remove ${item.title} from library`}
                onPress={() => confirmRemove(item)}
                style={[styles.iconButton, { borderColor: theme.border }]}
              >
                <Trash2 color={theme.mutedText} size={18} />
              </Pressable>
            </View>
          </View>
        )}
      />

      <Modal
        transparent
        animationType="slide"
        visible={Boolean(statusItem)}
        onRequestClose={() => setStatusItem(null)}
      >
        <Pressable
          style={[styles.overlay, { backgroundColor: theme.overlay }]}
          onPress={() => setStatusItem(null)}
        >
          <SafeAreaView
            edges={['bottom']}
            style={[styles.sheet, { backgroundColor: theme.elevated }]}
          >
            <Pressable onPress={(event) => event.stopPropagation()}>
              <View style={styles.sheetHeader}>
                <AppText variant="section">Tracking status</AppText>
                <AppText muted numberOfLines={1}>
                  {statusItem?.title}
                </AppText>
              </View>
              <View style={styles.statusList}>
                {statusOptions.map((option) => {
                  const selected = statusItem?.status === option.value;
                  return (
                    <Pressable
                      key={option.value}
                      onPress={() => {
                        if (!statusItem) return;
                        update.mutate({ id: statusItem.id, status: option.value });
                        setStatusItem(null);
                      }}
                      style={[
                        styles.statusOption,
                        { borderBottomColor: theme.border },
                      ]}
                    >
                      <AppText variant="label">{option.label}</AppText>
                      {selected ? <Check color={theme.primary} size={20} /> : null}
                    </Pressable>
                  );
                })}
              </View>
              <AppButton
                label="Cancel"
                variant="secondary"
                onPress={() => setStatusItem(null)}
              />
            </Pressable>
          </SafeAreaView>
        </Pressable>
      </Modal>
      {feedbackItem ? (
        <TrackingFeedbackSheet
          item={feedbackItem}
          pending={update.isPending}
          error={
            update.error
              ? getErrorMessage(update.error, 'Your rating could not be saved')
              : undefined
          }
          onClose={() => {
            if (!update.isPending) setFeedbackItem(null);
          }}
          onSave={(payload) =>
            update.mutate(
              { id: feedbackItem.id, ...payload },
              { onSuccess: () => setFeedbackItem(null) },
            )
          }
        />
      ) : null}
    </SafeAreaView>
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
  row: {
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: spacing.md,
  },
  mainRow: {
    minHeight: 82,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  copy: {
    flex: 1,
    minWidth: 0,
    gap: spacing.xs,
  },
  actions: {
    minHeight: 42,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing.sm,
  },
  statusButton: {
    flex: 1,
    minWidth: 0,
    minHeight: 42,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
  },
  iconButton: {
    width: 42,
    height: 42,
    borderWidth: 1,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    width: '100%',
    maxWidth: 620,
    alignSelf: 'center',
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: spacing.lg,
  },
  sheetHeader: {
    gap: spacing.xs,
    paddingBottom: spacing.md,
  },
  statusList: {
    marginBottom: spacing.lg,
  },
  statusOption: {
    minHeight: 50,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
});
