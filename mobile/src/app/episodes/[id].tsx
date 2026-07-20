import { Image } from 'expo-image';
import { Redirect, router, Stack, useLocalSearchParams } from 'expo-router';
import {
  Bookmark,
  BookmarkCheck,
  Check,
  CheckCircle2,
  Clock3,
  Film,
  Share2,
  Tv,
} from 'lucide-react-native';
import { Pressable, ScrollView, Share, StyleSheet, View } from 'react-native';

import { AppButton } from '@/components/app-button';
import { AppText } from '@/components/app-text';
import { imageUrl } from '@/components/poster';
import { ErrorState, LoadingState } from '@/components/screen-state';
import { radius, spacing } from '@/constants/theme';
import {
  useMarkCalendarEpisodeWatched,
  useSetEpisodePlanned,
} from '@/hooks/use-calendar';
import { useEpisodeDetail } from '@/hooks/use-media';
import { useTheme } from '@/hooks/use-theme';
import { episodePath, publicUrl } from '@/lib/deep-links';
import { episodeCode, formatDate, formatDateTime, formatRuntime } from '@/lib/format';
import { getErrorMessage } from '@/lib/http';
import { hydrateSession } from '@/lib/session';
import { hasLocalSession, useAuthStore } from '@/store/auth';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default function EpisodeDetailScreen() {
  const theme = useTheme();
  const params = useLocalSearchParams<{ id: string }>();
  const rawId = Array.isArray(params.id) ? params.id[0] : params.id;
  const id = rawId && UUID_PATTERN.test(rawId) ? rawId : '';
  const status = useAuthStore((state) => state.status);
  const sessionAvailable = hasLocalSession(status);
  const episode = useEpisodeDetail(sessionAvailable ? id : '');
  const plan = useSetEpisodePlanned();
  const watched = useMarkCalendarEpisodeWatched();
  const item = episode.data;

  if (!id) {
    return (
      <ErrorState
        message="This episode link is invalid"
        onRetry={() => router.replace('/')}
      />
    );
  }
  if (status === 'loading') return <LoadingState label="Restoring session" />;
  if (status === 'restore_error') {
    return (
      <ErrorState
        message="Your session is still saved. Check your connection and try again."
        onRetry={() => void hydrateSession()}
      />
    );
  }
  if (!sessionAvailable) {
    return (
      <Redirect
        href={{
          pathname: '/(auth)/login',
          params: { redirect: episodePath(id) },
        }}
      />
    );
  }
  if (episode.isLoading) return <LoadingState label="Loading episode" />;
  if (episode.isError || !item) {
    return (
      <ErrorState
        message={getErrorMessage(episode.error, 'This episode could not be loaded')}
        onRetry={() => void episode.refetch()}
      />
    );
  }

  const code = episodeCode(item.season_number, item.episode_number);
  const name = item.episode_name || `Episode ${item.episode_number}`;
  const runtime = formatRuntime(item.runtime_minutes);
  const artwork = imageUrl(item.still_path ?? item.poster_path, item.still_path ? 'w780' : 'w342');
  const canManage = item.tracking_status !== null && item.tracking_status !== 'dropped';
  const actionError = plan.error || watched.error;
  const shareUrl = publicUrl(episodePath(item.episode_id));

  return (
    <>
      <Stack.Screen options={{ title: code }} />
      <ScrollView
        style={{ backgroundColor: theme.background }}
        contentContainerStyle={styles.content}
      >
        {artwork ? (
          <Image
            source={{ uri: artwork }}
            contentFit="cover"
            transition={120}
            style={[styles.artwork, { backgroundColor: theme.surface }]}
          />
        ) : (
          <View style={[styles.artwork, styles.placeholder, { backgroundColor: theme.surface }]}> 
            <Film color={theme.mutedText} size={34} />
          </View>
        )}

        <View style={styles.header}>
          <Pressable
            accessibilityRole="link"
            onPress={() =>
              router.push({
                pathname: '/media/[id]',
                params: { id: String(item.tmdb_id), type: 'tv' },
              })
            }
            style={({ pressed }) => [styles.showLink, { opacity: pressed ? 0.7 : 1 }]}
          >
            <Tv color={theme.primary} size={17} />
            <AppText variant="label" style={{ color: theme.primary }} numberOfLines={2}>
              {item.title}
            </AppText>
          </Pressable>

          <AppText variant="caption" muted>{code}</AppText>
          <AppText variant="title">{name}</AppText>
          <View style={styles.metadata}>
            <AppText variant="caption" muted>
              {item.season_name || `Season ${item.season_number}`}
            </AppText>
            <AppText variant="caption" muted>
              {item.air_date ? formatDate(item.air_date) : 'Air date TBA'}
            </AppText>
            {runtime ? (
              <View style={styles.inlineMeta}>
                <Clock3 color={theme.mutedText} size={14} />
                <AppText variant="caption" muted>{runtime}</AppText>
              </View>
            ) : null}
          </View>
        </View>

        <View style={styles.actions}>
          <AppButton
            label={item.is_planned ? 'Remove from Watch next' : 'Watch next'}
            icon={
              item.is_planned ? (
                <BookmarkCheck color={theme.text} size={18} />
              ) : (
                <Bookmark color={theme.text} size={18} />
              )
            }
            variant="secondary"
            disabled={!canManage || item.is_watched}
            loading={plan.isPending}
            onPress={() =>
              plan.mutate({ episodeId: item.episode_id, planned: !item.is_planned })
            }
          />
          {item.is_available ? (
            <AppButton
              label={item.is_watched ? 'Watched' : 'Mark watched'}
              icon={
                item.is_watched ? (
                  <CheckCircle2 color="#FFFFFF" size={18} />
                ) : (
                  <Check color="#FFFFFF" size={18} />
                )
              }
              variant="success"
              disabled={!canManage || item.is_watched}
              loading={watched.isPending}
              onPress={() => watched.mutate(item.episode_id)}
            />
          ) : null}
          <AppButton
            label="Share"
            icon={<Share2 color={theme.text} size={18} />}
            variant="secondary"
            onPress={() =>
              void Share.share({
                title: `${item.title} ${code}`,
                message: `${item.title} ${code}: ${name}\n${shareUrl}`,
                url: shareUrl,
              })
            }
          />
        </View>

        {!canManage ? (
          <AppText variant="caption" muted>
            Add the series to your library to manage this episode.
          </AppText>
        ) : null}
        {!item.is_available ? (
          <AppText variant="caption" muted>
            This episode can be marked watched after its release date.
          </AppText>
        ) : null}
        {actionError ? (
          <AppText variant="caption" style={{ color: theme.danger }}>
            {getErrorMessage(actionError, 'This episode could not be updated')}
          </AppText>
        ) : null}

        <View style={[styles.overview, { borderTopColor: theme.border }]}> 
          <AppText variant="section">Overview</AppText>
          <AppText muted>
            {item.overview || 'No overview is available for this episode.'}
          </AppText>
          {item.last_watched_at ? (
            <AppText variant="caption" muted>
              Watched {item.watch_count} {item.watch_count === 1 ? 'time' : 'times'} · Last on{' '}
              {formatDateTime(item.last_watched_at)}
            </AppText>
          ) : null}
        </View>
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  content: {
    width: '100%',
    maxWidth: 820,
    alignSelf: 'center',
    padding: spacing.lg,
    paddingBottom: spacing.xxl,
    gap: spacing.lg,
  },
  artwork: {
    width: '100%',
    aspectRatio: 16 / 9,
    borderRadius: radius.md,
  },
  placeholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  header: {
    gap: spacing.sm,
  },
  showLink: {
    alignSelf: 'flex-start',
    maxWidth: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  metadata: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  inlineMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  overview: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: spacing.lg,
    gap: spacing.md,
  },
});
