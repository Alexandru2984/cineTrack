import { Redirect, router } from 'expo-router';
import {
  CalendarDays,
  Check,
  History as HistoryIcon,
  Plus,
  Repeat2,
  Search,
  Trash2,
  X,
} from 'lucide-react-native';
import { useMemo, useState } from 'react';
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
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
import { EmptyState, ErrorState, LoadingState } from '@/components/screen-state';
import { radius, spacing } from '@/constants/theme';
import {
  useCreateHistory,
  useDeleteHistory,
  useHistory,
} from '@/hooks/use-history';
import { useTheme } from '@/hooks/use-theme';
import { useTrackingInfinite } from '@/hooks/use-tracking';
import { formatDateTime } from '@/lib/format';
import {
  historyEpisodeLabel,
  localDateInput,
  previousLocalDate,
  uniqueHistory,
  watchedAtFromDateInput,
} from '@/lib/history';
import { getErrorMessage } from '@/lib/http';
import { hasLocalSession, useAuthStore } from '@/store/auth';
import type { HistoryItem, MediaType, TrackingItem } from '@/types';

interface HistoryTarget {
  mediaId: string;
  tmdbId: number;
  mediaType: MediaType;
  title: string;
  posterPath: string | null;
  episodeId?: string;
  episodeLabel?: string | null;
}

function targetFromTracking(item: TrackingItem): HistoryTarget {
  return {
    mediaId: item.media_id,
    tmdbId: item.tmdb_id,
    mediaType: item.media_type,
    title: item.title,
    posterPath: item.poster_path,
  };
}

function targetFromHistory(item: HistoryItem): HistoryTarget {
  return {
    mediaId: item.media_id,
    tmdbId: item.tmdb_id,
    mediaType: item.media_type,
    title: item.media_title,
    posterPath: item.poster_path,
    episodeId: item.episode_id ?? undefined,
    episodeLabel: historyEpisodeLabel(item),
  };
}

export default function HistoryScreen() {
  const theme = useTheme();
  const status = useAuthStore((state) => state.status);
  const hasSession = hasLocalSession(status);
  const [pickerVisible, setPickerVisible] = useState(false);
  const history = useHistory(hasSession);
  const library = useTrackingInfinite(undefined, hasSession && pickerVisible);
  const create = useCreateHistory();
  const remove = useDeleteHistory();
  const [target, setTarget] = useState<HistoryTarget | null>(null);
  const [dateInput, setDateInput] = useState(localDateInput);
  const [dateError, setDateError] = useState<string | null>(null);
  const [libraryQuery, setLibraryQuery] = useState('');

  const items = useMemo(
    () => uniqueHistory(history.data?.pages ?? []),
    [history.data?.pages],
  );
  const libraryItems = useMemo(() => {
    const unique = Array.from(
      new Map(
        (library.data?.pages.flatMap((page) => page) ?? []).map((item) => [
          item.media_id,
          item,
        ]),
      ).values(),
    );
    const query = libraryQuery.trim().toLocaleLowerCase();
    return query
      ? unique.filter((item) => item.title.toLocaleLowerCase().includes(query))
      : unique;
  }, [library.data?.pages, libraryQuery]);

  if (!hasSession) return <Redirect href="/" />;

  const openLog = (nextTarget: HistoryTarget) => {
    create.reset();
    setDateError(null);
    setDateInput(localDateInput());
    setPickerVisible(false);
    setTarget(nextTarget);
  };

  const closeLog = () => {
    if (create.isPending) return;
    setTarget(null);
    setDateError(null);
  };

  const submitLog = async () => {
    if (!target) return;
    const watchedAt = watchedAtFromDateInput(dateInput.trim());
    if (!watchedAt) {
      setDateError('Use a real date in YYYY-MM-DD format, no later than today.');
      return;
    }

    setDateError(null);
    try {
      await create.mutateAsync({
        mediaId: target.mediaId,
        episodeId: target.episodeId,
        watchedAt,
      });
      setTarget(null);
    } catch {
      // The mutation error is rendered in the sheet.
    }
  };

  const confirmUndo = (item: HistoryItem) => {
    Alert.alert(
      'Undo watch event?',
      `${item.media_title}${historyEpisodeLabel(item) ? ` · ${historyEpisodeLabel(item)}` : ''}`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Undo',
          style: 'destructive',
          onPress: () => remove.mutate(item.id),
        },
      ],
    );
  };

  return (
    <SafeAreaView
      style={[styles.safeArea, { backgroundColor: theme.background }]}
      edges={['bottom']}
    >
      <FlatList
        data={items}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={history.isRefetching && !history.isFetchingNextPage}
            onRefresh={() => void history.refetch()}
            tintColor={theme.primary}
            colors={[theme.primary]}
          />
        }
        onEndReached={() => {
          if (history.hasNextPage && !history.isFetchingNextPage) {
            void history.fetchNextPage();
          }
        }}
        onEndReachedThreshold={0.5}
        ListHeaderComponent={
          <View style={styles.header}>
            <ScreenHeader
              title="Watch history"
              subtitle={`${items.length}${history.hasNextPage ? '+' : ''} watch ${
                items.length === 1 ? 'event' : 'events'
              }`}
              right={
                <AppButton
                  label="Log watch"
                  compact
                  icon={<Plus color="#FFFFFF" size={18} />}
                  onPress={() => {
                    setLibraryQuery('');
                    setPickerVisible(true);
                  }}
                />
              }
            />
            {remove.error ? (
              <AppText variant="caption" style={{ color: theme.danger }}>
                {getErrorMessage(remove.error, 'The watch event could not be removed')}
              </AppText>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          history.isLoading ? (
            <LoadingState label="Loading watch history" />
          ) : history.isError ? (
            <ErrorState
              message={getErrorMessage(history.error, 'Watch history could not be loaded')}
              onRetry={() => void history.refetch()}
            />
          ) : (
            <EmptyState
              icon={HistoryIcon}
              title="No watch events"
              message="Watched movies and episodes will appear here."
              actionLabel="Log a watch"
              onAction={() => setPickerVisible(true)}
            />
          )
        }
        ListFooterComponent={
          history.isFetchingNextPage ? <LoadingState label="Loading more" /> : null
        }
        renderItem={({ item }) => {
          const episodeLabel = historyEpisodeLabel(item);
          return (
            <View style={[styles.historyRow, { borderBottomColor: theme.border }]}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Open ${item.media_title}`}
                onPress={() =>
                  router.push({
                    pathname: '/media/[id]',
                    params: { id: String(item.tmdb_id), type: item.media_type },
                  })
                }
                style={({ pressed }) => [
                  styles.historyMain,
                  { opacity: pressed ? 0.72 : 1 },
                ]}
              >
                <Poster path={item.poster_path} width={52} height={78} />
                <View style={styles.historyCopy}>
                  <AppText variant="label" numberOfLines={2}>
                    {item.media_title}
                  </AppText>
                  {episodeLabel ? (
                    <AppText variant="caption" numberOfLines={2}>
                      {episodeLabel}
                    </AppText>
                  ) : (
                    <AppText variant="caption" muted>
                      {item.media_type === 'tv' ? 'TV show' : 'Movie'}
                    </AppText>
                  )}
                  <AppText variant="caption" muted>
                    {formatDateTime(item.watched_at)}
                  </AppText>
                </View>
              </Pressable>
              <View style={styles.rowActions}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Log another watch for ${item.media_title}`}
                  onPress={() => openLog(targetFromHistory(item))}
                  style={({ pressed }) => [
                    styles.iconButton,
                    {
                      borderColor: theme.border,
                      backgroundColor: theme.elevated,
                      opacity: pressed ? 0.72 : 1,
                    },
                  ]}
                >
                  <Repeat2 color={theme.primary} size={18} />
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Undo watch event for ${item.media_title}`}
                  disabled={remove.isPending}
                  onPress={() => confirmUndo(item)}
                  style={({ pressed }) => [
                    styles.iconButton,
                    {
                      borderColor: theme.border,
                      backgroundColor: theme.elevated,
                      opacity: remove.isPending ? 0.45 : pressed ? 0.72 : 1,
                    },
                  ]}
                >
                  <Trash2 color={theme.mutedText} size={18} />
                </Pressable>
              </View>
            </View>
          );
        }}
      />

      <Modal
        visible={pickerVisible}
        animationType="slide"
        onRequestClose={() => setPickerVisible(false)}
      >
        <SafeAreaView style={[styles.modalPage, { backgroundColor: theme.background }]}>
          <View style={[styles.modalHeader, { borderBottomColor: theme.border }]}>
            <View style={styles.modalTitle}>
              <AppText variant="section">Choose from library</AppText>
              <AppText variant="caption" muted>
                Select the movie or show you watched.
              </AppText>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close title picker"
              onPress={() => setPickerVisible(false)}
              style={[styles.iconButton, { borderColor: theme.border }]}
            >
              <X color={theme.mutedText} size={20} />
            </Pressable>
          </View>
          <View
            style={[
              styles.searchField,
              { backgroundColor: theme.surface, borderColor: theme.border },
            ]}
          >
            <Search color={theme.mutedText} size={18} />
            <TextInput
              accessibilityLabel="Search loaded library titles"
              value={libraryQuery}
              onChangeText={setLibraryQuery}
              placeholder="Search library"
              placeholderTextColor={theme.mutedText}
              autoCapitalize="none"
              returnKeyType="search"
              style={[styles.searchInput, { color: theme.text }]}
            />
          </View>
          <FlatList
            data={libraryItems}
            keyExtractor={(item) => item.media_id}
            contentContainerStyle={styles.pickerList}
            keyboardShouldPersistTaps="handled"
            onEndReached={() => {
              if (library.hasNextPage && !library.isFetchingNextPage) {
                void library.fetchNextPage();
              }
            }}
            onEndReachedThreshold={0.5}
            ListEmptyComponent={
              library.isLoading ? (
                <LoadingState label="Loading library" />
              ) : library.isError ? (
                <ErrorState
                  message={getErrorMessage(library.error, 'Your library could not be loaded')}
                  onRetry={() => void library.refetch()}
                />
              ) : (
                <EmptyState
                  icon={Search}
                  title="No matching titles"
                  message="Try another title or add it to your library first."
                />
              )
            }
            ListFooterComponent={
              library.isFetchingNextPage ? <LoadingState label="Loading more" /> : null
            }
            renderItem={({ item }) => (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Select ${item.title}`}
                onPress={() => openLog(targetFromTracking(item))}
                style={({ pressed }) => [
                  styles.pickerRow,
                  {
                    borderBottomColor: theme.border,
                    opacity: pressed ? 0.72 : 1,
                  },
                ]}
              >
                <Poster path={item.poster_path} width={46} height={69} />
                <View style={styles.pickerCopy}>
                  <AppText variant="label" numberOfLines={2}>
                    {item.title}
                  </AppText>
                  <AppText variant="caption" muted>
                    {item.media_type === 'tv' ? 'TV show' : 'Movie'}
                  </AppText>
                </View>
                <Check color={theme.primary} size={20} />
              </Pressable>
            )}
          />
        </SafeAreaView>
      </Modal>

      <Modal
        transparent
        animationType="slide"
        visible={Boolean(target)}
        onRequestClose={closeLog}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={[styles.overlay, { backgroundColor: theme.overlay }]}
        >
          <Pressable style={styles.overlayPressable} onPress={closeLog}>
            <SafeAreaView
              edges={['bottom']}
              style={[styles.sheet, { backgroundColor: theme.elevated }]}
            >
              <Pressable onPress={(event) => event.stopPropagation()}>
                <View style={styles.sheetHeader}>
                  <View style={styles.sheetTitle}>
                    <AppText variant="section">
                      {target?.episodeId ? 'Log rewatch' : 'Log watch'}
                    </AppText>
                    <AppText muted numberOfLines={2}>
                      {target?.title}
                    </AppText>
                    {target?.episodeLabel ? (
                      <AppText variant="caption" numberOfLines={2}>
                        {target.episodeLabel}
                      </AppText>
                    ) : null}
                  </View>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Close watch form"
                    disabled={create.isPending}
                    onPress={closeLog}
                    style={[styles.iconButton, { borderColor: theme.border }]}
                  >
                    <X color={theme.mutedText} size={20} />
                  </Pressable>
                </View>

                <View style={styles.quickDates}>
                  <DateShortcut
                    label="Today"
                    selected={dateInput === localDateInput()}
                    onPress={() => {
                      setDateInput(localDateInput());
                      setDateError(null);
                    }}
                  />
                  <DateShortcut
                    label="Yesterday"
                    selected={dateInput === previousLocalDate()}
                    onPress={() => {
                      setDateInput(previousLocalDate());
                      setDateError(null);
                    }}
                  />
                </View>

                <View style={styles.fieldGroup}>
                  <AppText variant="label">Watched date</AppText>
                  <View
                    style={[
                      styles.dateField,
                      {
                        backgroundColor: theme.surface,
                        borderColor: dateError ? theme.danger : theme.border,
                      },
                    ]}
                  >
                    <CalendarDays color={theme.mutedText} size={18} />
                    <TextInput
                      accessibilityLabel="Watched date in year month day format"
                      value={dateInput}
                      onChangeText={(value) => {
                        setDateInput(value);
                        setDateError(null);
                      }}
                      placeholder="YYYY-MM-DD"
                      placeholderTextColor={theme.mutedText}
                      keyboardType="numbers-and-punctuation"
                      maxLength={10}
                      style={[styles.dateInput, { color: theme.text }]}
                    />
                  </View>
                  {dateError ? (
                    <AppText variant="caption" style={{ color: theme.danger }}>
                      {dateError}
                    </AppText>
                  ) : null}
                  {create.error ? (
                    <AppText variant="caption" style={{ color: theme.danger }}>
                      {getErrorMessage(create.error, 'The watch event could not be saved')}
                    </AppText>
                  ) : null}
                </View>

                <View style={styles.sheetActions}>
                  <AppButton
                    label="Cancel"
                    variant="secondary"
                    disabled={create.isPending}
                    onPress={closeLog}
                    style={styles.sheetAction}
                  />
                  <AppButton
                    label={target?.episodeId ? 'Log rewatch' : 'Log watch'}
                    loading={create.isPending}
                    onPress={() => void submitLog()}
                    style={styles.sheetAction}
                  />
                </View>
              </Pressable>
            </SafeAreaView>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

function DateShortcut({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.dateShortcut,
        {
          backgroundColor: selected ? theme.primarySoft : theme.surface,
          borderColor: selected ? theme.primary : theme.border,
          opacity: pressed ? 0.72 : 1,
        },
      ]}
    >
      <AppText variant="label" style={{ color: selected ? theme.primary : theme.text }}>
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
    gap: spacing.sm,
    paddingBottom: spacing.lg,
  },
  historyRow: {
    minHeight: 104,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: spacing.md,
  },
  historyMain: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  historyCopy: {
    flex: 1,
    minWidth: 0,
    gap: spacing.xs,
  },
  rowActions: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  iconButton: {
    width: 42,
    height: 42,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalPage: {
    flex: 1,
  },
  modalHeader: {
    minHeight: 76,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.lg,
  },
  modalTitle: {
    flex: 1,
    minWidth: 0,
    gap: spacing.xs,
  },
  searchField: {
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.md,
    margin: spacing.lg,
    paddingHorizontal: spacing.md,
  },
  searchInput: {
    flex: 1,
    minWidth: 0,
    minHeight: 44,
    fontSize: 15,
    paddingVertical: 0,
  },
  pickerList: {
    flexGrow: 1,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xxl,
  },
  pickerRow: {
    minHeight: 88,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: spacing.sm,
  },
  pickerCopy: {
    flex: 1,
    minWidth: 0,
    gap: spacing.xs,
  },
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  overlayPressable: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    width: '100%',
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: spacing.lg,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    paddingBottom: spacing.lg,
  },
  sheetTitle: {
    flex: 1,
    minWidth: 0,
    gap: spacing.xs,
  },
  quickDates: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingBottom: spacing.lg,
  },
  dateShortcut: {
    minHeight: 40,
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
  },
  fieldGroup: {
    gap: spacing.sm,
  },
  dateField: {
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
  },
  dateInput: {
    flex: 1,
    minWidth: 0,
    minHeight: 44,
    fontSize: 16,
    paddingVertical: 0,
  },
  sheetActions: {
    flexDirection: 'row',
    gap: spacing.md,
    paddingTop: spacing.xl,
  },
  sheetAction: {
    flex: 1,
  },
});
