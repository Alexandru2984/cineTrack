import { Search as SearchIcon } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import {
  FlatList,
  RefreshControl,
  StyleSheet,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText } from '@/components/app-text';
import { MediaTile, mediaResultType } from '@/components/media-tile';
import { ScreenHeader } from '@/components/screen-header';
import { EmptyState, ErrorState, LoadingState } from '@/components/screen-state';
import { SegmentedControl } from '@/components/segmented-control';
import { radius, spacing } from '@/constants/theme';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useMediaSearch } from '@/hooks/use-media';
import { useCreateTracking, useTrackingLookup } from '@/hooks/use-tracking';
import { useTheme } from '@/hooks/use-theme';
import { getErrorMessage } from '@/lib/http';
import type { MediaType, TmdbSearchResult } from '@/types';

type SearchType = 'all' | MediaType;

const typeOptions = [
  { value: 'all', label: 'All' },
  { value: 'movie', label: 'Movies' },
  { value: 'tv', label: 'TV shows' },
] as const;

export default function SearchScreen() {
  const theme = useTheme();
  const { width } = useWindowDimensions();
  const [query, setQuery] = useState('');
  const [type, setType] = useState<SearchType>('all');
  const [added, setAdded] = useState(() => new Set<string>());
  const debouncedQuery = useDebouncedValue(query.trim(), 350);
  const search = useMediaSearch(
    debouncedQuery,
    type === 'all' ? undefined : type,
  );
  const add = useCreateTracking();
  const columns = width >= 900 ? 4 : width >= 600 ? 3 : 2;
  const availableWidth = Math.min(width, 980) - spacing.lg * 2;
  const tileWidth = (availableWidth - spacing.md * (columns - 1)) / columns;
  const results = useMemo(() => {
    const flattened = search.data?.pages.flatMap((page) => page.results) ?? [];
    return Array.from(
      new Map(
        flattened.map((item) => [
          `${item.id}-${mediaResultType(item, type === 'all' ? undefined : type)}`,
          item,
        ]),
      ).values(),
    );
  }, [search.data, type]);
  const tracking = useTrackingLookup(
    results.map((item) => ({
      tmdb_id: item.id,
      media_type: mediaResultType(item, type === 'all' ? undefined : type),
    })),
  );
  const totalResults = search.data?.pages[0]?.total_results ?? 0;
  const trackedKeys = useMemo(
    () =>
      new Set([
        ...(tracking.data ?? []).map((item) => `${item.tmdb_id}-${item.media_type}`),
        ...added,
      ]),
    [added, tracking.data],
  );

  const addToPlan = (item: TmdbSearchResult) => {
    const mediaType = mediaResultType(item, type === 'all' ? undefined : type);
    const key = `${item.id}-${mediaType}`;
    add.mutate(
      { tmdb_id: item.id, media_type: mediaType, status: 'plan_to_watch' },
      {
        onSuccess: () =>
          setAdded((current) => {
            const next = new Set(current);
            next.add(key);
            return next;
          }),
      },
    );
  };

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: theme.background }]} edges={['top']}>
      <FlatList
        key={columns}
        data={results}
        numColumns={columns}
        keyExtractor={(item) =>
          `${item.id}-${mediaResultType(item, type === 'all' ? undefined : type)}`
        }
        columnWrapperStyle={columns > 1 ? styles.columns : undefined}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        onEndReached={() => {
          if (search.hasNextPage && !search.isFetchingNextPage) {
            void search.fetchNextPage();
          }
        }}
        onEndReachedThreshold={0.5}
        refreshControl={
          debouncedQuery.length >= 2 ? (
            <RefreshControl
              refreshing={search.isRefetching && !search.isFetchingNextPage}
              onRefresh={() => void search.refetch()}
              tintColor={theme.primary}
              colors={[theme.primary]}
            />
          ) : undefined
        }
        ListHeaderComponent={
          <View style={styles.header}>
            <ScreenHeader title="Search" subtitle="Movies and TV shows" />
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
                placeholder="Search titles"
                placeholderTextColor={theme.mutedText}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="search"
                maxLength={200}
                style={[styles.input, { color: theme.text }]}
              />
            </View>
            <SegmentedControl value={type} options={typeOptions} onChange={setType} />
            {debouncedQuery.length >= 2 && search.data ? (
              <AppText variant="caption" muted>
                {totalResults.toLocaleString()} results
              </AppText>
            ) : null}
            {add.error ? (
              <AppText variant="caption" style={{ color: theme.danger }}>
                {getErrorMessage(add.error, 'Could not add this title')}
              </AppText>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          debouncedQuery.length < 2 ? (
            <EmptyState
              icon={SearchIcon}
              title="Search your catalog"
              message="Enter at least two characters."
            />
          ) : search.isLoading ? (
            <LoadingState label="Searching" />
          ) : search.isError ? (
            <ErrorState
              message={getErrorMessage(search.error, 'Search could not be loaded')}
              onRetry={() => void search.refetch()}
            />
          ) : (
            <EmptyState
              icon={SearchIcon}
              title="No results"
              message="Try another title or media type."
            />
          )
        }
        ListFooterComponent={
          search.isFetchingNextPage ? <LoadingState label="Loading more" /> : null
        }
        renderItem={({ item }) => {
          const mediaType = mediaResultType(item, type === 'all' ? undefined : type);
          const key = `${item.id}-${mediaType}`;
          return (
            <View style={[styles.gridItem, { width: tileWidth }]}>
              <MediaTile
                item={item}
                fallbackType={type === 'all' ? undefined : type}
                onAdd={() => addToPlan(item)}
                added={trackedKeys.has(key)}
                addPending={
                  add.isPending &&
                  add.variables?.tmdb_id === item.id &&
                  add.variables.media_type === mediaType
                }
              />
            </View>
          );
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  content: {
    width: '100%',
    maxWidth: 980,
    alignSelf: 'center',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xxl,
  },
  header: {
    gap: spacing.lg,
    paddingBottom: spacing.xl,
  },
  searchBox: {
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
  columns: {
    gap: spacing.md,
    justifyContent: 'flex-start',
  },
  gridItem: {
    flexGrow: 0,
    flexShrink: 0,
    minWidth: 0,
    marginBottom: spacing.xl,
  },
});
