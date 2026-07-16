import { router } from 'expo-router';
import {
  Bookmark,
  BookmarkCheck,
  Check,
  LoaderCircle,
} from 'lucide-react-native';
import { Pressable, StyleSheet, View } from 'react-native';

import { AppText } from '@/components/app-text';
import { Poster } from '@/components/poster';
import { spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { episodeCode, formatDate, formatRuntime } from '@/lib/format';
import type { CalendarEpisode } from '@/types';

export function EpisodeRow({
  item,
  onPlan,
  onWatched,
  planPending = false,
  watchedPending = false,
}: {
  item: CalendarEpisode;
  onPlan: () => void;
  onWatched: () => void;
  planPending?: boolean;
  watchedPending?: boolean;
}) {
  const theme = useTheme();
  const runtime = formatRuntime(item.runtime_minutes);

  return (
    <View style={[styles.row, { borderBottomColor: theme.border }]}>
      <Pressable
        style={({ pressed }) => [styles.details, { opacity: pressed ? 0.72 : 1 }]}
        onPress={() =>
          router.push({
            pathname: '/media/[id]',
            params: { id: String(item.tmdb_id), type: 'tv' },
          })
        }
      >
        <Poster path={item.poster_path} width={50} height={75} />
        <View style={styles.copy}>
          <AppText variant="label" numberOfLines={1}>
            {item.title}
          </AppText>
          <AppText numberOfLines={1}>
            <AppText variant="caption" muted>
              {episodeCode(item.season_number, item.episode_number)}{' '}
            </AppText>
            {item.episode_name || `Episode ${item.episode_number}`}
          </AppText>
          <AppText variant="caption" muted numberOfLines={1}>
            {formatDate(item.air_date)}
            {runtime ? ` · ${runtime}` : ''}
          </AppText>
        </View>
      </Pressable>

      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={item.is_planned ? 'Remove from Watch next' : 'Add to Watch next'}
          disabled={planPending}
          onPress={onPlan}
          style={({ pressed }) => [
            styles.iconButton,
            {
              borderColor: item.is_planned ? theme.warning : theme.border,
              backgroundColor: item.is_planned ? theme.warningSoft : theme.elevated,
              opacity: planPending ? 0.5 : pressed ? 0.72 : 1,
            },
          ]}
        >
          {planPending ? (
            <LoaderCircle color={theme.warning} size={18} />
          ) : item.is_planned ? (
            <BookmarkCheck color={theme.warning} size={18} />
          ) : (
            <Bookmark color={theme.mutedText} size={18} />
          )}
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Mark episode watched"
          disabled={watchedPending}
          onPress={onWatched}
          style={({ pressed }) => [
            styles.iconButton,
            {
              borderColor: theme.success,
              backgroundColor: theme.successSoft,
              opacity: watchedPending ? 0.5 : pressed ? 0.72 : 1,
            },
          ]}
        >
          {watchedPending ? (
            <LoaderCircle color={theme.success} size={18} />
          ) : (
            <Check color={theme.success} size={19} strokeWidth={2.5} />
          )}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 100,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  details: {
    flex: 1,
    minWidth: 0,
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
    flexDirection: 'row',
    gap: spacing.sm,
  },
  iconButton: {
    width: 42,
    height: 42,
    borderWidth: 1,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
