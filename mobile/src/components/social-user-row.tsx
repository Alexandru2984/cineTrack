import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { AppText } from '@/components/app-text';
import { UserAvatar } from '@/components/user-avatar';
import { spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export function SocialUserRow({
  username,
  avatarUrl,
  bio,
  meta,
  action,
}: {
  username: string;
  avatarUrl: string | null;
  bio?: string | null;
  meta?: string;
  action?: ReactNode;
}) {
  const theme = useTheme();
  return (
    <View style={[styles.row, { borderBottomColor: theme.border }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open ${username}'s profile`}
        onPress={() =>
          router.push({ pathname: '/profile/[username]', params: { username } })
        }
        style={({ pressed }) => [{ opacity: pressed ? 0.72 : 1 }]}
      >
        <UserAvatar uri={avatarUrl} />
      </Pressable>
      <Pressable
        accessibilityRole="button"
        onPress={() =>
          router.push({ pathname: '/profile/[username]', params: { username } })
        }
        style={({ pressed }) => [styles.copy, { opacity: pressed ? 0.72 : 1 }]}
      >
        <AppText variant="label" numberOfLines={1}>{username}</AppText>
        {bio ? <AppText variant="caption" muted numberOfLines={1}>{bio}</AppText> : null}
        {meta ? <AppText variant="caption" muted numberOfLines={1}>{meta}</AppText> : null}
      </Pressable>
      {action}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 76,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: spacing.md,
  },
  copy: {
    flex: 1,
    minWidth: 0,
    gap: spacing.xs,
  },
});
