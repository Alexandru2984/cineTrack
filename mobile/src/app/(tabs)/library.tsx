import { router, useLocalSearchParams } from 'expo-router';
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
import { useT } from '@/hooks/use-t';
import { useTheme } from '@/hooks/use-theme';
import { getErrorMessage } from '@/lib/http';
import type { TrackingItem, TrackingStatus } from '@/types';

type LibraryFilter = 'all' | TrackingStatus;

const FILTERS: readonly LibraryFilter[] = [
  'all',
  'watching',
  'plan_to_watch',
  'completed',
  'on_hold',
  'dropped',
];

/** Params arrive as strings from the URL, so anything unrecognised is dropped. */
function requestedFilter(value: string | string[] | undefined): LibraryFilter | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return FILTERS.find((filter) => filter === candidate) ?? null;
}

export default function LibraryScreen() {
  const theme = useTheme();
  const t = useT();
  const filterOptions = FILTERS.map((value) => ({
    value,
    label: value === 'all' ? t('common.all') : t(`status.${value}`),
  }));
  const statusOptions = filterOptions.slice(1) as readonly {
    value: TrackingStatus;
    label: string;
  }[];
  // The route parameter is the filter, rather than a seed copied into local
  // state. This tab stays mounted between visits, so seeded state would ignore
  // every arrival after the first one, and keeping the two in step would mean
  // syncing state to a prop inside an effect. One source of truth avoids both,
  // and makes the current filter a link anyone can open.
  const params = useLocalSearchParams<{ status?: string }>();
  const filter = requestedFilter(params.status) ?? 'all';
  const setFilter = (next: LibraryFilter) => router.setParams({ status: next });
  const [statusItem, setStatusItem] = useState<TrackingItem | null>(null);
  const [feedbackItem, setFeedbackItem] = useState<TrackingItem | null>(null);
  const tracking = useTrackingInfinite(filter === 'all' ? undefined : filter);
  const update = useUpdateTracking();
  const remove = useDeleteTracking();
  const mutationError = update.error || remove.error;
  const items = tracking.data?.pages.flatMap((page) => page) ?? [];

  const confirmRemove = (item: TrackingItem) => {
    Alert.alert(t('library.removeConfirmTitle'), item.title, [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.remove'),
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
              title={t('library.title')}
              subtitle={
                tracking.data
                  ? t(items.length === 1 ? 'library.titleCount' : 'library.titleCountPlural', {
                      count: `${items.length}${tracking.hasNextPage ? '+' : ''}`,
                    })
                  : t('library.subtitleFallback')
              }
            />
            <SegmentedControl value={filter} options={filterOptions} onChange={setFilter} />
            {mutationError ? (
              <AppText variant="caption" style={{ color: theme.danger }}>
                {getErrorMessage(mutationError, t('library.updateError'))}
              </AppText>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          tracking.isLoading ? (
            <LoadingState label={t('library.loading')} />
          ) : tracking.isError ? (
            <ErrorState
              message={getErrorMessage(tracking.error, t('library.loadError'))}
              onRetry={() => void tracking.refetch()}
            />
          ) : (
            <EmptyState
              icon={SlidersHorizontal}
              title={t('library.emptyTitle')}
              message={t('library.emptyMessage')}
            />
          )
        }
        ListFooterComponent={
          tracking.isFetchingNextPage ? <LoadingState label={t('common.loadingMore')} /> : null
        }
        renderItem={({ item }) => (
          <View style={[styles.row, { borderBottomColor: theme.border }]}>
            <Pressable
              accessibilityRole="button"
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
                  {t(item.media_type === 'tv' ? 'mediaType.tv' : 'mediaType.movie')}
                </AppText>
                {item.rating ? (
                  <AppText variant="caption" style={{ color: theme.warning }}>
                    {t('library.rating', { value: item.rating })}
                  </AppText>
                ) : null}
              </View>
            </Pressable>
            <View style={styles.actions}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('library.editRatingFor', { title: item.title })}
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
                accessibilityLabel={t('library.changeStatusFor', { title: item.title })}
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
                  {t(`status.${item.status}`)}
                </AppText>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={
                  item.is_favorite
                    ? t('library.removeFavorite', { title: item.title })
                    : t('library.addFavorite', { title: item.title })
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
                accessibilityLabel={t('library.removeFromLibraryFor', { title: item.title })}
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
          // Not a control: the dimmed backdrop behind a sheet. Announcing
          // it as a button would be noise, so it leaves the tree entirely.
          accessible={false}
          style={[styles.overlay, { backgroundColor: theme.overlay }]}
          onPress={() => setStatusItem(null)}
        >
          <SafeAreaView
            edges={['bottom']}
            style={[styles.sheet, { backgroundColor: theme.elevated }]}
          >
            <Pressable
              // Not a control: a wrapper that exists only to stop taps reaching the backdrop. Announcing
              // it as a button would be noise, so it leaves the tree entirely.
              accessible={false}
              onPress={(event) => event.stopPropagation()}>
              <View style={styles.sheetHeader}>
                <AppText variant="section">{t('library.trackingStatus')}</AppText>
                <AppText muted numberOfLines={1}>
                  {statusItem?.title}
                </AppText>
              </View>
              <View style={styles.statusList}>
                {statusOptions.map((option) => {
                  const selected = statusItem?.status === option.value;
                  return (
                    <Pressable
                      accessibilityRole="button"
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
                label={t('common.cancel')}
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
              ? getErrorMessage(update.error, t('library.ratingSaveError'))
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
