import { Redirect, router } from 'expo-router';
import { MessageCircle } from 'lucide-react-native';
import { useMemo } from 'react';
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText } from '@/components/app-text';
import { ScreenHeader } from '@/components/screen-header';
import { EmptyState, ErrorState, LoadingState } from '@/components/screen-state';
import { UserAvatar } from '@/components/user-avatar';
import { radius, spacing } from '@/constants/theme';
import {
  useMessageConversations,
  useMessageSummary,
} from '@/hooks/use-messages';
import { useT } from '@/hooks/use-t';
import { useTheme } from '@/hooks/use-theme';
import { formatDateTime } from '@/lib/format';
import { getErrorMessage } from '@/lib/http';
import { uniqueConversations } from '@/lib/messages';
import { hydrateSession } from '@/lib/session';
import { hasLocalSession, useAuthStore } from '@/store/auth';
import type { MessageConversation } from '@/types';

export default function MessagesScreen() {
  const theme = useTheme();
  const t = useT();
  const status = useAuthStore((state) => state.status);
  const currentUserId = useAuthStore((state) => state.user?.id);
  const sessionAvailable = hasLocalSession(status);
  const online = status === 'authenticated';
  const conversations = useMessageConversations(online);
  const summary = useMessageSummary(online);
  const items = useMemo(
    () => uniqueConversations(conversations.data?.pages ?? []),
    [conversations.data],
  );
  const unreadCount = summary.data?.unread_count ?? 0;
  const subtitle = unreadCount === 0
    ? t('messages.allRead')
    : t(
        unreadCount === 1 ? 'messages.unreadOne' : 'messages.unreadMany',
        { count: unreadCount },
      );

  if (status === 'loading') return <LoadingState label={t('session.restoring')} />;
  if (status === 'restore_error') {
    return (
      <ErrorState
        message={t('session.restoreError')}
        onRetry={() => void hydrateSession()}
      />
    );
  }
  if (!sessionAvailable) return <Redirect href="/" />;
  if (!online) {
    return (
      <ErrorState
        message={t('messages.offline')}
        onRetry={() => void hydrateSession()}
      />
    );
  }

  const refresh = () => {
    void conversations.refetch();
    void summary.refetch();
  };

  return (
    <SafeAreaView
      style={[styles.safeArea, { backgroundColor: theme.background }]}
      edges={['bottom']}
    >
      <FlatList
        data={items}
        keyExtractor={(item) => item.user_id}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={conversations.isRefetching || summary.isRefetching}
            onRefresh={refresh}
            tintColor={theme.primary}
            colors={[theme.primary]}
          />
        }
        ListHeaderComponent={<ScreenHeader title={t('messages.title')} subtitle={subtitle} />}
        ListEmptyComponent={
          conversations.isLoading ? (
            <LoadingState label={t('messages.loading')} />
          ) : conversations.isError ? (
            <ErrorState
              message={getErrorMessage(conversations.error, t('messages.loadError'))}
              onRetry={() => void conversations.refetch()}
            />
          ) : (
            <EmptyState
              icon={MessageCircle}
              title={t('messages.emptyTitle')}
              message={t('messages.emptyMessage')}
            />
          )
        }
        ListFooterComponent={
          conversations.isFetchingNextPage ? (
            <LoadingState label={t('messages.loadingOlder')} />
          ) : null
        }
        onEndReached={() => {
          if (conversations.hasNextPage && !conversations.isFetchingNextPage) {
            void conversations.fetchNextPage();
          }
        }}
        onEndReachedThreshold={0.35}
        renderItem={({ item }) => (
          <ConversationRow conversation={item} currentUserId={currentUserId} />
        )}
      />
    </SafeAreaView>
  );
}

function ConversationRow({
  conversation,
  currentUserId,
}: {
  conversation: MessageConversation;
  currentUserId: string | undefined;
}) {
  const theme = useTheme();
  const t = useT();
  const unread = conversation.unread_count > 0;
  const preview = conversation.last_message_sender_id === currentUserId
    ? `${t('messages.you')}: ${conversation.last_message_body}`
    : conversation.last_message_body;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('messages.openConversation', {
        username: conversation.username,
      })}
      onPress={() =>
        router.push({
          pathname: '/messages/[username]',
          params: { username: conversation.username },
        })
      }
      style={({ pressed }) => [
        styles.row,
        {
          borderBottomColor: theme.border,
          backgroundColor: unread ? theme.primarySoft : 'transparent',
          opacity: pressed ? 0.75 : 1,
        },
      ]}
    >
      <UserAvatar uri={conversation.avatar_url} size={46} />
      <View style={styles.rowCopy}>
        <View style={styles.rowHeader}>
          <AppText variant="label" numberOfLines={1} style={styles.username}>
            {conversation.username}
          </AppText>
          <AppText variant="caption" muted>
            {formatDateTime(conversation.last_message_at)}
          </AppText>
        </View>
        <View style={styles.previewRow}>
          <AppText
            variant={unread ? 'label' : 'caption'}
            muted={!unread}
            numberOfLines={1}
            style={styles.preview}
          >
            {preview}
          </AppText>
          {unread ? (
            <View
              accessibilityLabel={t('messages.unread')}
              style={[styles.badge, { backgroundColor: theme.primary }]}
            >
              <AppText variant="caption" style={styles.badgeText}>
                {conversation.unread_count > 99 ? '99+' : conversation.unread_count}
              </AppText>
            </View>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  content: {
    width: '100%',
    maxWidth: 760,
    flexGrow: 1,
    alignSelf: 'center',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xxl,
  },
  row: {
    minHeight: 86,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.md,
  },
  rowCopy: { flex: 1, minWidth: 0, gap: spacing.xs },
  rowHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  username: { flex: 1 },
  previewRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  preview: { flex: 1, minWidth: 0 },
  badge: {
    minWidth: 22,
    height: 22,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xs,
  },
  badgeText: { color: '#FFFFFF', fontWeight: '700' },
});
