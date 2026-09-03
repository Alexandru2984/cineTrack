import { Image } from 'expo-image';
import { Redirect, router, Stack, useLocalSearchParams } from 'expo-router';
import {
  Calendar,
  Check,
  CheckCheck,
  Clock3,
  ListPlus,
  Share2,
  Star,
} from 'lucide-react-native';
import { useMemo, useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  View,
} from 'react-native';

import { AppButton } from '@/components/app-button';
import { AppText } from '@/components/app-text';
import { AddToListSheet } from '@/components/add-to-list-sheet';
import { imageUrl, Poster } from '@/components/poster';
import { ErrorState, LoadingState } from '@/components/screen-state';
import { SegmentedControl } from '@/components/segmented-control';
import { TrackingFeedbackSheet } from '@/components/tracking-feedback-sheet';
import { WatchProviders } from '@/components/watch-providers';
import { CommunityRating } from '@/components/community-rating';
import { radius, spacing } from '@/constants/theme';
import { useEpisodes, useMediaDetail, useSeasons } from '@/hooks/use-media';
import {
  useCreateTracking,
  useMarkEpisodeWatched,
  useMarkEpisodesWatchedThrough,
  useMarkSeasonWatched,
  useShowProgress,
  useTrackingLookup,
  useUpdateTracking,
  useWatchedEpisodes,
} from '@/hooks/use-tracking';
import { useT } from '@/hooks/use-t';
import { useTheme } from '@/hooks/use-theme';
import { episodeCode, formatDate, formatRuntime } from '@/lib/format';
import { getErrorMessage } from '@/lib/http';
import { mediaPath, publicUrl } from '@/lib/deep-links';
import { hydrateSession } from '@/lib/session';
import { hasLocalSession, useAuthStore } from '@/store/auth';
import type {
  Episode,
  MediaType,
  SeasonWatchProgress,
  TrackingItem,
  TrackingStatus,
} from '@/types';

const MAX_TMDB_ID = 2_147_483_647;

function localDateKey() {
  const date = new Date();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function normalizeTmdbId(value: string | undefined) {
  if (!value || !/^[1-9]\d{0,9}$/.test(value)) return '';
  const id = Number(value);
  return Number.isSafeInteger(id) && id <= MAX_TMDB_ID ? String(id) : '';
}

export default function MediaDetailScreen() {
  const theme = useTheme();
  const t = useT();
  const statusOptions = [
    { value: 'watching', label: t('status.watching') },
    { value: 'plan_to_watch', label: t('status.plan_to_watch') },
    { value: 'completed', label: t('status.completed') },
    { value: 'on_hold', label: t('status.on_hold') },
    { value: 'dropped', label: t('status.dropped') },
  ] as const;
  const params = useLocalSearchParams<{ id: string; type?: string }>();
  const rawId = Array.isArray(params.id) ? params.id[0] : params.id;
  const id = normalizeTmdbId(rawId);
  const rawType = Array.isArray(params.type) ? params.type[0] : params.type;
  const type: MediaType = rawType === 'tv' ? 'tv' : 'movie';
  const status = useAuthStore((state) => state.status);
  const sessionAvailable = hasLocalSession(status);
  const requestId = sessionAvailable ? id : '';
  const media = useMediaDetail(requestId, type);
  const seasons = useSeasons(requestId, type === 'tv');
  const tracking = useTrackingLookup(
    requestId ? [{ tmdb_id: Number(requestId), media_type: type }] : [],
  );
  const createTracking = useCreateTracking();
  const updateTracking = useUpdateTracking();
  const [feedbackItem, setFeedbackItem] = useState<TrackingItem | null>(null);
  const [listPickerOpen, setListPickerOpen] = useState(false);
  const [listFeedback, setListFeedback] = useState<string | null>(null);
  const [statusSelection, setStatusSelection] = useState<{
    mediaKey: string;
    status: TrackingStatus;
  } | null>(null);
  const [seasonSelection, setSeasonSelection] = useState<{
    mediaId: string;
    seasonNumber: number;
  } | null>(null);
  const mediaKey = `${type}:${id}`;
  const existingTracking = tracking.data?.find(
    (trackingItem) =>
      trackingItem.tmdb_id === Number(id) && trackingItem.media_type === type,
  );
  const existingStatus = existingTracking?.status;
  const selectedStatus =
    statusSelection?.mediaKey === mediaKey
      ? statusSelection.status
      : existingStatus ?? null;
  const availableSeasons = seasons.data ?? [];
  const requestedSeason =
    seasonSelection && seasonSelection.mediaId === id
      ? seasonSelection.seasonNumber
      : null;
  const selectedSeason =
    requestedSeason !== null &&
    availableSeasons.some(
      (season) => season.season_number === requestedSeason,
    )
      ? requestedSeason
      : availableSeasons.find((season) => season.season_number > 0)?.season_number ??
        availableSeasons[0]?.season_number ??
        null;

  const episodes = useEpisodes(type === 'tv' ? requestId : '', selectedSeason);
  const watchedEpisodes = useWatchedEpisodes(media.data?.tmdb_id, selectedSeason);
  const progress = useShowProgress(media.data?.tmdb_id);
  const markEpisode = useMarkEpisodeWatched();
  const markSeason = useMarkSeasonWatched();
  const markThrough = useMarkEpisodesWatchedThrough();
  const watchedSet = useMemo(
    () => new Set(watchedEpisodes.data ?? []),
    [watchedEpisodes.data],
  );
  const progressBySeason = useMemo(
    () =>
      new Map<number, SeasonWatchProgress>(
        (progress.data ?? []).map((entry) => [entry.season_number, entry]),
      ),
    [progress.data],
  );
  const watchableEpisodes = (episodes.data ?? []).filter(
    (episode) => !episode.air_date || episode.air_date <= localDateKey(),
  );
  const seasonUnwatched = watchableEpisodes.filter(
    (episode) => !watchedSet.has(episode.episode_number),
  ).length;
  const bulkPending = markSeason.isPending || markThrough.isPending;
  const backdrop = imageUrl(media.data?.backdrop_path, 'w780');
  const mutationError =
    createTracking.error ||
    updateTracking.error ||
    markEpisode.error ||
    markSeason.error ||
    markThrough.error;

  if (!id) {
    return (
      <ErrorState
        message={t('media.invalidLink')}
        onRetry={() => router.replace('/')}
      />
    );
  }
  if (status === 'loading') return <LoadingState label={t('session.restoring')} />;
  if (status === 'restore_error') {
    return (
      <ErrorState
        message={t('session.restoreError')}
        onRetry={() => void hydrateSession()}
      />
    );
  }
  if (!sessionAvailable) {
    return (
      <Redirect
        href={{
          pathname: '/(auth)/login',
          params: { redirect: mediaPath(id, type) },
        }}
      />
    );
  }
  if (media.isLoading) return <LoadingState label={t('media.loadingDetails')} />;
  if (media.isError || !media.data) {
    return (
      <ErrorState
        message={getErrorMessage(media.error, t('media.loadError'))}
        onRetry={() => void media.refetch()}
      />
    );
  }

  const item = media.data;
  const runtime = formatRuntime(item.runtime_minutes);
  const shareUrl = publicUrl(mediaPath(item.tmdb_id, type));

  const changeStatus = (status: TrackingStatus) => {
    setStatusSelection({ mediaKey, status });
    createTracking.mutate(
      { tmdb_id: item.tmdb_id, media_type: type, status },
      {
        onError: () => setStatusSelection(null),
      },
    );
  };

  const previousUnwatchedCount = (episode: Episode) => {
    if (selectedSeason === null) return 0;
    const earlierSeasonCount = (seasons.data ?? [])
      .filter(
        (season) =>
          season.season_number > 0 && season.season_number < selectedSeason,
      )
      .reduce((total, season) => {
        const seasonProgress = progressBySeason.get(season.season_number);
        const expected =
          seasonProgress?.episode_count ??
          season.episode_count ??
          seasonProgress?.available_episode_count ??
          0;
        return total + Math.max(0, expected - (seasonProgress?.watched_count ?? 0));
      }, 0);
    const earlierInSeason = (episodes.data ?? []).filter(
      (candidate) =>
        candidate.episode_number < episode.episode_number &&
        !watchedSet.has(candidate.episode_number),
    ).length;
    return earlierSeasonCount + earlierInSeason;
  };

  const watchEpisode = (episode: Episode) => {
    if (selectedSeason === null) return;
    const variables = {
      tmdbId: item.tmdb_id,
      seasonNumber: selectedSeason,
      episodeNumber: episode.episode_number,
    };
    const previousCount = previousUnwatchedCount(episode);
    if (previousCount === 0) {
      markEpisode.mutate(variables);
      return;
    }

    Alert.alert(
      t('media.markEpisodeConfirmTitle', {
        code: episodeCode(selectedSeason, episode.episode_number),
      }),
      t(previousCount === 1 ? 'media.earlierUnwatchedOne' : 'media.earlierUnwatchedMany', {
        count: previousCount,
      }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('media.onlyThis'), onPress: () => markEpisode.mutate(variables) },
        {
          text: t('media.thisAndPrevious'),
          onPress: () => markThrough.mutate(variables),
        },
      ],
    );
  };

  const confirmSeason = () => {
    if (selectedSeason === null || seasonUnwatched === 0) return;
    Alert.alert(
      t('media.markSeasonConfirmTitle'),
      t(seasonUnwatched === 1 ? 'media.seasonAddOne' : 'media.seasonAddMany', {
        count: seasonUnwatched,
      }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('media.markSeason'),
          onPress: () =>
            markSeason.mutate({
              tmdbId: item.tmdb_id,
              seasonNumber: selectedSeason,
            }),
        },
      ],
    );
  };

  return (
    <>
      <Stack.Screen options={{ title: item.title }} />
      <ScrollView
        style={{ backgroundColor: theme.background }}
        contentContainerStyle={styles.content}
      >
        {backdrop ? (
          // Decorative: a backdrop carries no information the page does not
          // already state in text.
          <Image
            accessible={false}
            source={{ uri: backdrop }}
            contentFit="cover"
            transition={120}
            style={styles.backdrop}
          />
        ) : null}

        <View style={styles.summary}>
          <Poster path={item.poster_path} width={104} height={156} />
          <View style={styles.summaryCopy}>
            <AppText variant="title" numberOfLines={3}>
              {item.title}
            </AppText>
            {item.original_title && item.original_title !== item.title ? (
              <AppText muted numberOfLines={2}>
                {item.original_title}
              </AppText>
            ) : null}
            <View style={styles.metadata}>
              {item.vote_average ? (
                <Metadata
                  icon={Star}
                  label={Number(item.vote_average).toFixed(1)}
                  color={theme.warning}
                />
              ) : null}
              {item.release_date ? (
                <Metadata icon={Calendar} label={formatDate(item.release_date)} />
              ) : null}
              {runtime ? <Metadata icon={Clock3} label={runtime} /> : null}
            </View>
          </View>
        </View>

        {item.genres?.length ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.genres}
          >
            {item.genres.map((genre) => (
              <View
                key={genre.id || genre.name}
                style={[styles.genre, { backgroundColor: theme.surface }]}
              >
                <AppText variant="caption">{genre.name}</AppText>
              </View>
            ))}
          </ScrollView>
        ) : null}

        <View style={styles.shareAction}>
          <AppButton
            label={t('common.share')}
            variant="secondary"
            compact
            icon={<Share2 color={theme.mutedText} size={18} />}
            onPress={() =>
              void Share.share({
                title: item.title,
                message: `${item.title}\n${shareUrl}`,
                url: shareUrl,
              })
            }
          />
        </View>

        <View style={styles.section}>
          <AppText variant="section">{t('media.tracking')}</AppText>
          <SegmentedControl
            value={selectedStatus}
            options={statusOptions}
            onChange={changeStatus}
            disabled={createTracking.isPending}
          />
          {selectedStatus ? (
            <AppText variant="caption" muted>
              {t('media.currentStatus', { status: t(`status.${selectedStatus}`) })}
            </AppText>
          ) : null}
          <View style={styles.listAction}>
            <AppButton
              label={t('media.customList')}
              variant="secondary"
              compact
              icon={<ListPlus color={theme.mutedText} size={18} />}
              onPress={() => {
                setListFeedback(null);
                setListPickerOpen(true);
              }}
            />
            {listFeedback ? (
              <AppText variant="caption" style={{ color: theme.success }}>
                {listFeedback}
              </AppText>
            ) : null}
          </View>
        </View>

        {existingTracking ? (
          <View style={styles.section}>
            <View style={styles.feedbackHeader}>
              <View style={styles.feedbackCopy}>
                <AppText variant="section">{t('media.yourTake')}</AppText>
                <View style={styles.feedbackRating}>
                  <Star
                    color={theme.warning}
                    fill={existingTracking.rating ? theme.warning : 'transparent'}
                    size={18}
                  />
                  <AppText variant="label">
                    {existingTracking.rating
                      ? t('library.rating', { value: existingTracking.rating })
                      : t('media.notRated')}
                  </AppText>
                </View>
              </View>
              <AppButton
                label={existingTracking.rating || existingTracking.review ? t('common.edit') : t('media.add')}
                variant="secondary"
                compact
                onPress={() => {
                  updateTracking.reset();
                  setFeedbackItem(existingTracking);
                }}
              />
            </View>
            {existingTracking.review ? (
              <AppText muted>{existingTracking.review}</AppText>
            ) : (
              <AppText variant="caption" muted>
                {t('media.addNoteHint')}
              </AppText>
            )}
          </View>
        ) : null}

        {item.overview ? (
          <View style={styles.section}>
            <AppText variant="section">{t('media.overview')}</AppText>
            <AppText muted>{item.overview}</AppText>
          </View>
        ) : null}

        <View style={styles.section}>
          <CommunityRating tmdbId={item.tmdb_id} mediaType={type} />
        </View>

        <View style={styles.section}>
          <WatchProviders tmdbId={item.tmdb_id} mediaType={type} />
        </View>

        {type === 'tv' ? (
          <View style={styles.section}>
            <AppText variant="section">{t('media.seasons')}</AppText>
            {seasons.isLoading ? (
              <LoadingState label={t('media.loadingSeasons')} />
            ) : seasons.isError ? (
              <ErrorState
                message={getErrorMessage(seasons.error, t('media.seasonsLoadError'))}
                onRetry={() => void seasons.refetch()}
              />
            ) : seasons.data?.length ? (
              <>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.seasonTabs}
                >
                  {seasons.data.map((season) => {
                    const selected = selectedSeason === season.season_number;
                    const seasonProgress = progressBySeason.get(season.season_number);
                    const total = seasonProgress?.episode_count ?? season.episode_count;
                    return (
                      <Pressable
                        key={season.id}
                        accessibilityRole="tab"
                        accessibilityState={{ selected }}
                        onPress={() =>
                          setSeasonSelection({
                            mediaId: id,
                            seasonNumber: season.season_number,
                          })
                        }
                        style={({ pressed }) => [
                          styles.seasonTab,
                          {
                            borderColor: selected ? theme.primary : theme.border,
                            backgroundColor: selected ? theme.primary : theme.elevated,
                            opacity: pressed ? 0.72 : 1,
                          },
                        ]}
                      >
                        <AppText
                          variant="label"
                          style={{ color: selected ? '#FFFFFF' : theme.text }}
                        >
                          {season.season_number === 0
                            ? t('media.specials')
                            : t('episode.seasonN', { number: season.season_number })}
                        </AppText>
                        {total !== null && total !== undefined ? (
                          <AppText
                            variant="caption"
                            style={{
                              color: selected ? 'rgba(255,255,255,0.78)' : theme.mutedText,
                            }}
                          >
                            {seasonProgress
                              ? `${seasonProgress.watched_count}/${total}`
                              : t(total === 1 ? 'media.episodeCountOne' : 'media.episodeCountMany', {
                                  count: total,
                                })}
                          </AppText>
                        ) : null}
                      </Pressable>
                    );
                  })}
                </ScrollView>

                <View style={[styles.seasonHeader, { borderColor: theme.border }]}>
                  <AppText variant="caption" muted>
                    {t('media.watchedOfTotal', {
                      watched: watchedSet.size,
                      total: episodes.data?.length ?? 0,
                    })}
                  </AppText>
                  <AppButton
                    label={seasonUnwatched === 0 ? t('media.seasonWatched') : t('media.markSeasonWatched')}
                    icon={
                      seasonUnwatched === 0 ? (
                        <Check color="#FFFFFF" size={17} />
                      ) : (
                        <CheckCheck color="#FFFFFF" size={17} />
                      )
                    }
                    variant="success"
                    compact
                    disabled={seasonUnwatched === 0}
                    loading={bulkPending}
                    onPress={confirmSeason}
                  />
                </View>

                {episodes.isLoading ? (
                  <LoadingState label={t('media.loadingEpisodes')} />
                ) : episodes.isError ? (
                  <ErrorState
                    message={getErrorMessage(episodes.error, t('media.episodesLoadError'))}
                    onRetry={() => void episodes.refetch()}
                  />
                ) : episodes.data?.length ? (
                  <View style={[styles.episodes, { borderTopColor: theme.border }]}>
                    {episodes.data.map((episode) => {
                      const watched = watchedSet.has(episode.episode_number);
                      return (
                        <View
                          key={episode.id}
                          style={[styles.episodeRow, { borderBottomColor: theme.border }]}
                        >
                          <View style={[styles.number, { backgroundColor: theme.surface }]}>
                            <AppText variant="label">{episode.episode_number}</AppText>
                          </View>
                          <View style={styles.episodeCopy}>
                            <Pressable
                              accessibilityRole="link"
                              onPress={() =>
                                router.push({
                                  pathname: '/episodes/[id]',
                                  params: { id: episode.id },
                                })
                              }
                            >
                              <AppText variant="label" numberOfLines={2}>
                                {episode.name || t('common.episodeN', { number: episode.episode_number })}
                              </AppText>
                            </Pressable>
                            <AppText variant="caption" muted>
                              {episode.air_date ? formatDate(episode.air_date) : t('episode.airDateTba')}
                              {episode.runtime_minutes
                                ? ` · ${formatRuntime(episode.runtime_minutes)}`
                                : ''}
                            </AppText>
                            {episode.overview ? (
                              <AppText muted numberOfLines={3}>
                                {episode.overview}
                              </AppText>
                            ) : null}
                          </View>
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={
                              watched ? t('media.episodeWatchedAria') : t('episodeRow.markWatched')
                            }
                            disabled={watched || markEpisode.isPending || bulkPending}
                            onPress={() => watchEpisode(episode)}
                            style={({ pressed }) => [
                              styles.watchButton,
                              {
                                borderColor: watched ? theme.success : theme.border,
                                backgroundColor: watched
                                  ? theme.successSoft
                                  : theme.elevated,
                                opacity:
                                  watched || markEpisode.isPending || bulkPending
                                    ? 0.65
                                    : pressed
                                      ? 0.72
                                      : 1,
                              },
                            ]}
                          >
                            <Check
                              color={watched ? theme.success : theme.mutedText}
                              size={19}
                            />
                          </Pressable>
                        </View>
                      );
                    })}
                  </View>
                ) : (
                  <AppText muted>{t('media.noEpisodes')}</AppText>
                )}
              </>
            ) : (
              <AppText muted>{t('media.noSeasons')}</AppText>
            )}
          </View>
        ) : null}

        {mutationError ? (
          <View style={[styles.error, { backgroundColor: theme.dangerSoft }]}>
            <AppText variant="caption" style={{ color: theme.danger }}>
              {getErrorMessage(mutationError, t('media.updateError'))}
            </AppText>
          </View>
        ) : null}
      </ScrollView>
      {feedbackItem ? (
        <TrackingFeedbackSheet
          item={feedbackItem}
          pending={updateTracking.isPending}
          error={
            updateTracking.error
              ? getErrorMessage(updateTracking.error, t('library.ratingSaveError'))
              : undefined
          }
          onClose={() => {
            if (!updateTracking.isPending) setFeedbackItem(null);
          }}
          onSave={(payload) =>
            updateTracking.mutate(
              { id: feedbackItem.id, ...payload },
              { onSuccess: () => setFeedbackItem(null) },
            )
          }
        />
      ) : null}
      {listPickerOpen ? (
        <AddToListSheet
          mediaId={item.id}
          title={item.title}
          onClose={() => setListPickerOpen(false)}
          onAdded={(listName) => {
            setListFeedback(t('media.addedToList', { name: listName }));
            setListPickerOpen(false);
          }}
        />
      ) : null}
    </>
  );
}

function Metadata({
  icon: Icon,
  label,
  color,
}: {
  icon: typeof Star;
  label: string;
  color?: string;
}) {
  const theme = useTheme();
  return (
    <View style={styles.metadataItem}>
      <Icon color={color || theme.mutedText} size={15} />
      <AppText variant="caption" muted>
        {label}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    width: '100%',
    maxWidth: 900,
    alignSelf: 'center',
    paddingBottom: spacing.xxl,
    gap: spacing.xl,
  },
  backdrop: {
    width: '100%',
    aspectRatio: 16 / 8,
  },
  summary: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.lg,
    paddingHorizontal: spacing.lg,
  },
  summaryCopy: {
    flex: 1,
    minWidth: 0,
    gap: spacing.sm,
  },
  metadata: {
    gap: spacing.sm,
  },
  metadataItem: {
    minHeight: 22,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  genres: {
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  genre: {
    minHeight: 30,
    borderRadius: 15,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  section: {
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  shareAction: {
    alignItems: 'flex-start',
    paddingHorizontal: spacing.lg,
  },
  listAction: {
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  feedbackHeader: {
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  feedbackCopy: {
    flex: 1,
    minWidth: 0,
    gap: spacing.xs,
  },
  feedbackRating: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  seasonTabs: {
    gap: spacing.sm,
  },
  seasonTab: {
    minHeight: 54,
    minWidth: 108,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    justifyContent: 'center',
    gap: spacing.xs,
  },
  seasonHeader: {
    minHeight: 60,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: spacing.sm,
  },
  episodes: {
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  episodeRow: {
    minHeight: 98,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: spacing.md,
  },
  number: {
    width: 36,
    height: 36,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  episodeCopy: {
    flex: 1,
    minWidth: 0,
    gap: spacing.xs,
  },
  watchButton: {
    width: 42,
    height: 42,
    borderWidth: 1,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  error: {
    marginHorizontal: spacing.lg,
    borderRadius: radius.md,
    padding: spacing.md,
  },
});
