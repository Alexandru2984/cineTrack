import { router, useLocalSearchParams } from 'expo-router';
import {
  Check,
  Heart,
  MoreHorizontal,
  Search as SearchIcon,
  SlidersHorizontal,
  Star,
  Trash2,
} from 'lucide-react-native';
import { useEffect, useState } from 'react';
import {
  Alert,
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppButton } from '@/components/app-button';
import { AppText } from '@/components/app-text';
import { Poster } from '@/components/poster';
import { ScreenHeader } from '@/components/screen-header';
import {
  LIBRARY_SORTS,
  LibraryFilterSheet,
  type LibraryFilterChanges,
} from '@/components/library-filter-sheet';
import { EmptyState, ErrorState, LoadingState } from '@/components/screen-state';
import { SegmentedControl } from '@/components/segmented-control';
import { TrackingFeedbackSheet } from '@/components/tracking-feedback-sheet';
import { radius, spacing } from '@/constants/theme';
import {
  useDeleteTracking,
  useTrackingFacets,
  useTrackingInfinite,
  useUpdateTracking,
  type LibraryFilters,
} from '@/hooks/use-tracking';
import { useT } from '@/hooks/use-t';
import { useTheme } from '@/hooks/use-theme';
import { getErrorMessage } from '@/lib/http';
import { useLocaleStore } from '@/store/locale';
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

/** How long typing pauses before the search runs. */
const SEARCH_DELAY_MS = 300;

type RouteParam = string | string[] | undefined;

function first(value: RouteParam) {
  return Array.isArray(value) ? value[0] : value;
}

/** Params arrive as strings from the URL, so anything unrecognised is dropped. */
function requestedFilter(value: RouteParam): LibraryFilter | null {
  const candidate = first(value);
  return FILTERS.find((filter) => filter === candidate) ?? null;
}

function requestedFilters(params: Record<string, RouteParam>): Omit<LibraryFilters, 'q'> {
  const status = requestedFilter(params.status);
  const type = first(params.type);
  const genre = first(params.genre);
  const sort = first(params.sort);
  return {
    status: status && status !== 'all' ? status : undefined,
    mediaType: type === 'movie' || type === 'tv' ? type : undefined,
    genre: genre && (genre === 'anime' || /^[1-9]\d{0,8}$/.test(genre)) ? genre : undefined,
    favorite: first(params.favorite) === '1' || undefined,
    sort: LIBRARY_SORTS.find((candidate) => candidate === sort),
  };
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
  // The other filters follow the same rule; only the search box is local,
  // since a half-typed word is not a place anyone links to.
  const params = useLocalSearchParams<{
    status?: string;
    type?: string;
    genre?: string;
    favorite?: string;
    sort?: string;
  }>();
  const filter = requestedFilter(params.status) ?? 'all';
  const setFilter = (next: LibraryFilter) => router.setParams({ status: next });
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query]);
  const filters: LibraryFilters = { ...requestedFilters(params), q: search || undefined };
  const narrowed = Boolean(filters.mediaType || filters.genre || filters.favorite || filters.q);
  const activeFilterCount = [filters.mediaType, filters.genre, filters.favorite, filters.sort]
    .filter(Boolean).length;
  const [filtersOpen, setFiltersOpen] = useState(false);
  const changeFilters = (changes: LibraryFilterChanges) =>
    router.setParams({
      ...('type' in changes && { type: changes.type }),
      ...('genre' in changes && { genre: changes.genre }),
      ...('favorite' in changes && { favorite: changes.favorite ? '1' : undefined }),
      ...('sort' in changes && { sort: changes.sort }),
    });
  const clearFilters = () => {
    setQuery('');
    setSearch('');
    router.setParams({ type: undefined, genre: undefined, favorite: undefined });
  };
  const locale = useLocaleStore((state) => state.locale);
  // The one item whose options sheet is open: status, rating, favorite, removal.
  const [menuItem, setMenuItem] = useState<TrackingItem | null>(null);
  const [feedbackItem, setFeedbackItem] = useState<TrackingItem | null>(null);
  const tracking = useTrackingInfinite(filters);
  const facets = useTrackingFacets(filters, locale);
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
                facets.data
                  ? t(facets.data.total === 1 ? 'library.titleCount' : 'library.titleCountPlural', {
                      count: facets.data.total,
                    })
                  : tracking.data
                    ? t(items.length === 1 ? 'library.titleCount' : 'library.titleCountPlural', {
                        count: `${items.length}${tracking.hasNextPage ? '+' : ''}`,
                      })
                    : t('library.subtitleFallback')
              }
            />
            <View style={styles.searchRow}>
              <View
                style={[
                  styles.searchBox,
                  { backgroundColor: theme.elevated, borderColor: theme.border },
                ]}
              >
                <SearchIcon color={theme.mutedText} size={20} />
                <TextInput
                  value={query}
                  onChangeText={setQuery}
                  accessibilityLabel={t('library.search')}
                  placeholder={t('library.searchPlaceholder')}
                  placeholderTextColor={theme.mutedText}
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="search"
                  maxLength={100}
                  style={[styles.input, { color: theme.text }]}
                />
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={
                  activeFilterCount
                    ? t('library.filtersActive', { count: activeFilterCount })
                    : t('library.filters')
                }
                onPress={() => setFiltersOpen(true)}
                style={({ pressed }) => [
                  styles.filterButton,
                  {
                    borderColor: activeFilterCount ? theme.primary : theme.border,
                    backgroundColor: activeFilterCount ? theme.primarySoft : theme.elevated,
                    opacity: pressed ? 0.72 : 1,
                  },
                ]}
              >
                <SlidersHorizontal
                  color={activeFilterCount ? theme.primary : theme.mutedText}
                  size={20}
                />
                {activeFilterCount ? (
                  <AppText variant="caption" style={{ color: theme.primary }}>
                    {activeFilterCount}
                  </AppText>
                ) : null}
              </Pressable>
            </View>
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
          ) : narrowed ? (
            <View style={styles.noMatches}>
              <EmptyState
                icon={SearchIcon}
                title={t('library.noMatchesTitle')}
                message={t('library.noMatchesMessage')}
              />
              <AppButton
                label={t('library.clearFilters')}
                variant="secondary"
                onPress={clearFilters}
              />
            </View>
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
          // One compact line per title. The four action buttons that used to sit
          // under every title took half a phone screen per row, so only about
          // four titles fitted; they live in the options sheet now, one tap away.
          <View style={[styles.row, { borderBottomColor: theme.border }]}>
            <Pressable
              accessibilityRole="button"
              onPress={() =>
                router.push({
                  pathname: '/media/[id]',
                  params: { id: String(item.tmdb_id), type: item.media_type },
                })
              }
              style={({ pressed }) => [styles.mainRow, { opacity: pressed ? 0.72 : 1 }]}
            >
              <Poster path={item.poster_path} width={46} height={69} />
              <View style={styles.copy}>
                <AppText variant="label" numberOfLines={2}>
                  {item.title}
                </AppText>
                <AppText variant="caption" muted numberOfLines={1}>
                  {t(item.media_type === 'tv' ? 'mediaType.tv' : 'mediaType.movie')}
                  {item.release_date ? ` · ${item.release_date.slice(0, 4)}` : ''}
                  {' · '}
                  {t(`status.${item.status}`)}
                </AppText>
                {item.rating || item.is_favorite ? (
                  <View style={styles.badges}>
                    {item.rating ? (
                      <View style={styles.badge}>
                        <Star color={theme.warning} fill={theme.warning} size={13} />
                        <AppText variant="caption" style={{ color: theme.warning }}>
                          {t('library.rating', { value: item.rating })}
                        </AppText>
                      </View>
                    ) : null}
                    {item.is_favorite ? (
                      <Heart color={theme.danger} fill={theme.danger} size={13} />
                    ) : null}
                  </View>
                ) : null}
              </View>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('library.moreActionsFor', { title: item.title })}
              hitSlop={6}
              onPress={() => setMenuItem(item)}
              style={({ pressed }) => [
                styles.menuButton,
                { borderColor: theme.border, opacity: pressed ? 0.72 : 1 },
              ]}
            >
              <MoreHorizontal color={theme.mutedText} size={20} />
            </Pressable>
          </View>
        )}
      />

      <Modal
        transparent
        animationType="slide"
        visible={Boolean(menuItem)}
        onRequestClose={() => setMenuItem(null)}
      >
        <Pressable
          // Not a control: the dimmed backdrop behind a sheet. Announcing
          // it as a button would be noise, so it leaves the tree entirely.
          accessible={false}
          style={[styles.overlay, { backgroundColor: theme.overlay }]}
          onPress={() => setMenuItem(null)}
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
                  {menuItem?.title}
                </AppText>
              </View>
              <View style={styles.statusList}>
                {statusOptions.map((option) => {
                  const selected = menuItem?.status === option.value;
                  return (
                    <Pressable
                      accessibilityRole="button"
                      key={option.value}
                      onPress={() => {
                        if (!menuItem) return;
                        update.mutate({ id: menuItem.id, status: option.value });
                        setMenuItem(null);
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
              <AppText variant="caption" muted style={styles.sheetSection}>
                {t('library.actions')}
              </AppText>
              <View style={styles.statusList}>
                <SheetAction
                  icon={Star}
                  label={t('library.rateAction')}
                  onPress={() => {
                    if (!menuItem) return;
                    update.reset();
                    setFeedbackItem(menuItem);
                    setMenuItem(null);
                  }}
                />
                <SheetAction
                  icon={Heart}
                  label={t(menuItem?.is_favorite ? 'library.favoriteRemove' : 'library.favoriteAdd')}
                  onPress={() => {
                    if (!menuItem) return;
                    update.mutate({ id: menuItem.id, is_favorite: !menuItem.is_favorite });
                    setMenuItem(null);
                  }}
                />
                <SheetAction
                  icon={Trash2}
                  label={t('library.removeAction')}
                  danger
                  onPress={() => {
                    if (!menuItem) return;
                    const item = menuItem;
                    setMenuItem(null);
                    confirmRemove(item);
                  }}
                />
              </View>
              <AppButton
                label={t('common.cancel')}
                variant="secondary"
                onPress={() => setMenuItem(null)}
              />
            </Pressable>
          </SafeAreaView>
        </Pressable>
      </Modal>
      <LibraryFilterSheet
        visible={filtersOpen}
        filters={filters}
        facets={facets.data}
        onChange={changeFilters}
        onClear={() => {
          clearFilters();
          router.setParams({ sort: undefined });
        }}
        onClose={() => setFiltersOpen(false)}
      />
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

function SheetAction({
  icon: Icon,
  label,
  danger = false,
  onPress,
}: {
  icon: typeof Star;
  label: string;
  danger?: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  const color = danger ? theme.danger : theme.text;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.statusOption,
        styles.sheetAction,
        { borderBottomColor: theme.border, opacity: pressed ? 0.72 : 1 },
      ]}
    >
      <Icon color={color} size={19} />
      <AppText variant="label" style={{ color }}>
        {label}
      </AppText>
    </Pressable>
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
  searchRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  searchBox: {
    flex: 1,
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
  },
  input: {
    flex: 1,
    minHeight: 46,
    fontSize: 16,
  },
  filterButton: {
    minWidth: 48,
    minHeight: 48,
    flexDirection: 'row',
    gap: spacing.xs,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  noMatches: {
    gap: spacing.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  mainRow: {
    flex: 1,
    minWidth: 0,
    minHeight: 69,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  copy: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  badges: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  menuButton: {
    width: 44,
    height: 44,
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
  sheetSection: {
    textTransform: 'uppercase',
    paddingBottom: spacing.xs,
  },
  sheetAction: {
    justifyContent: 'flex-start',
    gap: spacing.md,
  },
  statusOption: {
    minHeight: 50,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
});
