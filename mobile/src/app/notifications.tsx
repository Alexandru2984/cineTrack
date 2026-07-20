import { Image } from 'expo-image';
import { Redirect, router } from 'expo-router';
import { Bell, CheckCheck, UserRound } from 'lucide-react-native';
import { useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText } from '@/components/app-text';
import { EmptyState, ErrorState, LoadingState } from '@/components/screen-state';
import { radius, spacing } from '@/constants/theme';
import {
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotificationSummary,
  useNotifications,
} from '@/hooks/use-notifications';
import { useTheme } from '@/hooks/use-theme';
import { formatDateTime } from '@/lib/format';
import { getErrorMessage } from '@/lib/http';
import { notificationAction, uniqueNotifications } from '@/lib/notifications';
import { useAuthStore } from '@/store/auth';

export default function NotificationsScreen() {
  const theme = useTheme();
  const status = useAuthStore((state) => state.status);
  const authenticated = status === 'authenticated';
  const summary = useNotificationSummary(authenticated);
  const notifications = useNotifications(authenticated);
  const markRead = useMarkNotificationRead();
  const markAll = useMarkAllNotificationsRead();
  const [refreshing, setRefreshing] = useState(false);
  const pages = [
    ...(summary.data ? [summary.data] : []),
    ...(notifications.data?.pages ?? []),
  ];
  const items = uniqueNotifications(pages);
  const unreadCount =
    summary.data?.unread_count ?? notifications.data?.pages[0]?.unread_count ?? 0;
  const loading = summary.isLoading && notifications.isLoading;
  const error = summary.isError && notifications.isError;
  const mutationError = markRead.error || markAll.error;

  if (!authenticated) return <Redirect href="/" />;

  const refresh = async () => {
    setRefreshing(true);
    try {
      await Promise.all([summary.refetch(), notifications.refetch()]);
    } finally {
      setRefreshing(false);
    }
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
            refreshing={refreshing}
            onRefresh={() => void refresh()}
            tintColor={theme.primary}
            colors={[theme.primary]}
          />
        }
        onEndReached={() => {
          if (notifications.hasNextPage && !notifications.isFetchingNextPage) {
            void notifications.fetchNextPage();
          }
        }}
        onEndReachedThreshold={0.5}
        ListHeaderComponent={
          <View style={styles.header}>
            <View style={styles.headerCopy}>
              <AppText muted>
                {unreadCount === 0
                  ? 'You are all caught up.'
                  : `${unreadCount} unread notification${unreadCount === 1 ? '' : 's'}`}
              </AppText>
              {mutationError ? (
                <AppText variant="caption" style={{ color: theme.danger }}>
                  {getErrorMessage(mutationError, 'Notifications could not be updated')}
                </AppText>
              ) : null}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Mark all notifications as read"
              disabled={unreadCount === 0 || markAll.isPending}
              onPress={() => markAll.mutate()}
              style={({ pressed }) => [
                styles.markAll,
                {
                  borderColor: theme.border,
                  opacity: unreadCount === 0 ? 0.4 : pressed ? 0.72 : 1,
                },
              ]}
            >
              {markAll.isPending ? (
                <ActivityIndicator color={theme.primary} size="small" />
              ) : (
                <CheckCheck color={theme.primary} size={20} />
              )}
            </Pressable>
          </View>
        }
        ListEmptyComponent={
          loading ? (
            <LoadingState label="Loading notifications" />
          ) : error ? (
            <ErrorState
              message="Notifications could not be loaded"
              onRetry={() => void Promise.all([summary.refetch(), notifications.refetch()])}
            />
          ) : (
            <EmptyState
              icon={Bell}
              title="No notifications"
              message="Social updates will appear here."
            />
          )
        }
        ListFooterComponent={
          notifications.isFetchingNextPage ? <LoadingState label="Loading older notifications" /> : null
        }
        renderItem={({ item }) => {
          const unread = item.read_at === null;
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${item.actor_username} ${notificationAction(item.kind)}${
                unread ? ', unread' : ''
              }`}
              onPress={() => {
                if (unread) markRead.mutate(item.id);
                router.push({
                  pathname: '/profile/[username]',
                  params: { username: item.actor_username },
                });
              }}
              style={({ pressed }) => [
                styles.row,
                {
                  borderBottomColor: theme.border,
                  backgroundColor: unread ? theme.primarySoft : 'transparent',
                  opacity: pressed ? 0.78 : 1,
                },
              ]}
            >
              <View style={[styles.avatar, { backgroundColor: theme.surface }]}>
                {item.actor_avatar_url ? (
                  <Image
                    source={{ uri: item.actor_avatar_url }}
                    contentFit="cover"
                    transition={120}
                    style={styles.avatarImage}
                  />
                ) : (
                  <UserRound color={theme.mutedText} size={21} />
                )}
              </View>
              <View style={styles.rowCopy}>
                <AppText>
                  <AppText variant="label">{item.actor_username}</AppText>{' '}
                  <AppText muted>{notificationAction(item.kind)}</AppText>
                </AppText>
                <AppText variant="caption" muted>
                  {formatDateTime(item.created_at)}
                </AppText>
              </View>
              {unread ? (
                <View
                  accessibilityLabel="Unread"
                  style={[styles.unread, { backgroundColor: theme.primary }]}
                />
              ) : null}
            </Pressable>
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
    maxWidth: 760,
    flexGrow: 1,
    alignSelf: 'center',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xxl,
  },
  header: {
    minHeight: 72,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  headerCopy: {
    flex: 1,
    minWidth: 0,
    gap: spacing.xs,
  },
  markAll: {
    width: 44,
    height: 44,
    borderWidth: 1,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  row: {
    minHeight: 82,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm,
  },
  avatar: {
    width: 44,
    height: 44,
    flexShrink: 0,
    borderRadius: 22,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarImage: {
    width: '100%',
    height: '100%',
  },
  rowCopy: {
    flex: 1,
    minWidth: 0,
    gap: spacing.xs,
  },
  unread: {
    width: 8,
    height: 8,
    flexShrink: 0,
    borderRadius: 4,
  },
});
