import { router } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';

import { AppText } from '@/components/app-text';
import { Poster } from '@/components/poster';
import { UserAvatar } from '@/components/user-avatar';
import { spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { episodeCode, formatDateTime } from '@/lib/format';
import type { ActivityItem } from '@/types';

export function SocialActivityRow({ item, showUser = true }: { item: ActivityItem; showUser?: boolean }) {
  const theme = useTheme();
  const episode = item.season_number !== null && item.episode_number !== null
    ? `${episodeCode(item.season_number, item.episode_number)}${item.episode_name ? ` · ${item.episode_name}` : ''}`
    : null;
  return (
    <View style={[styles.row, { borderBottomColor: theme.border }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open ${item.media_title}`}
        onPress={() =>
          router.push({
            pathname: '/media/[id]',
            params: { id: String(item.tmdb_id), type: item.media_type },
          })
        }
      >
        <Poster path={item.poster_path} width={48} height={72} />
      </Pressable>
      <View style={styles.copy}>
        {showUser ? (
          <Pressable
            accessibilityRole="button"
            onPress={() =>
              router.push({ pathname: '/people/[username]', params: { username: item.username } })
            }
            style={styles.user}
          >
            <UserAvatar uri={item.avatar_url} size={28} />
            <AppText variant="label" numberOfLines={1} style={styles.username}>
              {item.username}
            </AppText>
            <AppText variant="caption" muted>{item.action}</AppText>
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="button"
          onPress={() =>
            router.push({
              pathname: '/media/[id]',
              params: { id: String(item.tmdb_id), type: item.media_type },
            })
          }
        >
          <AppText variant="label" numberOfLines={1}>{item.media_title}</AppText>
        </Pressable>
        {episode ? <AppText variant="caption" muted numberOfLines={1}>{episode}</AppText> : null}
        <AppText variant="caption" muted>{formatDateTime(item.timestamp)}</AppText>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 96,
    flexDirection: 'row',
    gap: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: spacing.md,
  },
  copy: {
    flex: 1,
    minWidth: 0,
    justifyContent: 'center',
    gap: spacing.xs,
  },
  user: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  username: {
    maxWidth: '52%',
  },
});
