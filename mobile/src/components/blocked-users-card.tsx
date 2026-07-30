import { ShieldOff } from 'lucide-react-native';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { AppButton } from '@/components/app-button';
import { AppText } from '@/components/app-text';
import { UserAvatar } from '@/components/user-avatar';
import { radius, spacing } from '@/constants/theme';
import {
  useBlockedUsers,
  useUnblockUser,
} from '@/hooks/use-community-safety';
import { useT } from '@/hooks/use-t';
import { useTheme } from '@/hooks/use-theme';
import { getErrorMessage } from '@/lib/http';

export function BlockedUsersCard() {
  const theme = useTheme();
  const t = useT();
  const blocked = useBlockedUsers();
  const unblock = useUnblockUser();
  const users = blocked.data?.pages.flat() ?? [];

  return (
    <View
      style={[
        styles.section,
        {
          borderBottomColor: theme.border,
        },
      ]}
    >
      <View style={styles.heading}>
        <ShieldOff color={theme.mutedText} size={20} />
        <View style={styles.headingCopy}>
          <AppText variant="section">{t('safety.blockedTitle')}</AppText>
          <AppText variant="caption" muted>
            {t('safety.blockedHint')}
          </AppText>
        </View>
      </View>

      {blocked.isLoading ? (
        <ActivityIndicator color={theme.primary} />
      ) : blocked.isError ? (
        <View style={styles.message}>
          <AppText variant="caption" style={{ color: theme.danger }}>
            {getErrorMessage(blocked.error, t('safety.blockedLoadError'))}
          </AppText>
          <AppButton
            label={t('common.tryAgain')}
            variant="secondary"
            compact
            onPress={() => void blocked.refetch()}
          />
        </View>
      ) : users.length === 0 ? (
        <AppText muted>{t('safety.blockedEmpty')}</AppText>
      ) : (
        <View style={[styles.users, { borderColor: theme.border }]}>
          {users.map((user, index) => (
            <View
              key={user.id}
              style={[
                styles.user,
                index > 0 && {
                  borderTopColor: theme.border,
                  borderTopWidth: StyleSheet.hairlineWidth,
                },
              ]}
            >
              <UserAvatar uri={user.avatar_url} size={40} />
              <AppText variant="label" numberOfLines={2} style={styles.username}>
                {user.username}
              </AppText>
              <AppButton
                label={t('safety.unblock')}
                variant="secondary"
                compact
                loading={unblock.isPending && unblock.variables === user.username}
                disabled={unblock.isPending}
                onPress={() => unblock.mutate(user.username)}
              />
            </View>
          ))}
        </View>
      )}

      {blocked.hasNextPage ? (
        <AppButton
          label={t('common.loadMore')}
          variant="secondary"
          loading={blocked.isFetchingNextPage}
          onPress={() => void blocked.fetchNextPage()}
        />
      ) : null}

      {unblock.error ? (
        <AppText variant="caption" style={{ color: theme.danger }}>
          {getErrorMessage(unblock.error, t('safety.unblockError'))}
        </AppText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    gap: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: spacing.xl,
  },
  heading: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  headingCopy: {
    flex: 1,
    minWidth: 0,
    gap: spacing.xs,
  },
  message: {
    alignItems: 'flex-start',
    gap: spacing.md,
  },
  users: {
    overflow: 'hidden',
    borderWidth: 1,
    borderRadius: radius.md,
  },
  user: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  username: {
    flex: 1,
    minWidth: 0,
  },
});
