import * as Crypto from 'expo-crypto';
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { Flag, MessageCircle, Send } from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppButton } from '@/components/app-button';
import { AppText } from '@/components/app-text';
import { ReportSheet } from '@/components/report-sheet';
import { EmptyState, ErrorState, LoadingState } from '@/components/screen-state';
import { UserAvatar } from '@/components/user-avatar';
import { radius, spacing } from '@/constants/theme';
import {
  useMarkMessageThreadRead,
  useMessageThread,
  useSendMessage,
} from '@/hooks/use-messages';
import { useT } from '@/hooks/use-t';
import { useTheme } from '@/hooks/use-theme';
import { messagePath, safePostAuthRedirect } from '@/lib/deep-links';
import { formatDateTime } from '@/lib/format';
import { getErrorMessage } from '@/lib/http';
import {
  clampMessageBody,
  messageCharacterCount,
  MESSAGE_BODY_LIMIT,
  nonceForMessage,
  normalizeMessageBody,
  uniqueThreadMessages,
  type MessageRetry,
} from '@/lib/messages';
import { hydrateSession } from '@/lib/session';
import { hasLocalSession, useAuthStore } from '@/store/auth';
import type { DirectMessage } from '@/types';

export default function MessageThreadScreen() {
  const theme = useTheme();
  const t = useT();
  const status = useAuthStore((state) => state.status);
  const currentUser = useAuthStore((state) => state.user);
  const params = useLocalSearchParams<{ username: string }>();
  const username = Array.isArray(params.username) ? params.username[0] : params.username;
  const returnTo = safePostAuthRedirect(messagePath(username ?? ''));
  const sessionAvailable = hasLocalSession(status);
  const thread = useMessageThread(
    username ?? '',
    status === 'authenticated' && returnTo !== null,
  );
  const sendMessage = useSendMessage();
  const { mutate: markRead, isPending: isMarkingRead } = useMarkMessageThreadRead();
  const [body, setBody] = useState('');
  const [retry, setRetry] = useState<MessageRetry | null>(null);
  const [reporting, setReporting] = useState<DirectMessage | null>(null);
  const lastReadRequest = useRef<string | null>(null);
  const messages = useMemo(
    () => uniqueThreadMessages(thread.data?.pages ?? []),
    [thread.data],
  );
  const displayMessages = useMemo(() => [...messages].reverse(), [messages]);
  const currentThread = thread.data?.pages[0];
  const lastOwnMessageId = [...messages]
    .reverse()
    .find((message) => message.sender_id === currentUser?.id)?.id;
  const newestUnreadIncoming = [...messages]
    .reverse()
    .find(
      (message) =>
        message.recipient_id === currentUser?.id && message.read_at === null,
    );

  useEffect(() => {
    if (!username || !newestUnreadIncoming || isMarkingRead) return;
    if (lastReadRequest.current === newestUnreadIncoming.id) return;

    lastReadRequest.current = newestUnreadIncoming.id;
    markRead(
      { username, throughId: newestUnreadIncoming.id },
      { onError: () => { lastReadRequest.current = null; } },
    );
  }, [isMarkingRead, markRead, newestUnreadIncoming, username]);

  if (!returnTo) {
    return (
      <ErrorState
        message={t('profile.invalidLink')}
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
        href={{ pathname: '/(auth)/login', params: { redirect: String(returnTo) } }}
      />
    );
  }
  if (status === 'offline') {
    return (
      <ErrorState
        message={t('messages.offline')}
        onRetry={() => void hydrateSession()}
      />
    );
  }
  if (thread.isLoading) return <LoadingState label={t('messages.threadLoading')} />;
  if (thread.isError || !currentThread) {
    return (
      <ErrorState
        message={getErrorMessage(thread.error, t('messages.threadLoadError'))}
        onRetry={() => void thread.refetch()}
      />
    );
  }

  const submit = () => {
    const normalizedBody = normalizeMessageBody(body);
    if (
      !username ||
      normalizedBody.length === 0 ||
      messageCharacterCount(normalizedBody) > MESSAGE_BODY_LIMIT ||
      sendMessage.isPending ||
      !currentThread.can_message
    ) {
      return;
    }

    const nonce = nonceForMessage(normalizedBody, retry, () => Crypto.randomUUID());
    setRetry({ body: normalizedBody, nonce });
    sendMessage.mutate(
      { username, body: normalizedBody, clientNonce: nonce },
      {
        onSuccess: () => {
          setBody('');
          setRetry(null);
        },
      },
    );
  };

  return (
    <SafeAreaView
      style={[styles.safeArea, { backgroundColor: theme.background }]}
      edges={['bottom']}
    >
      <KeyboardAvoidingView
        style={styles.safeArea}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 88 : 0}
      >
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={t('social.openProfileAria', {
            username: currentThread.user.username,
          })}
          onPress={() =>
            router.push({
              pathname: '/profile/[username]',
              params: { username: currentThread.user.username },
            })
          }
          style={({ pressed }) => [
            styles.peerHeader,
            { borderBottomColor: theme.border, opacity: pressed ? 0.72 : 1 },
          ]}
        >
          <UserAvatar uri={currentThread.user.avatar_url} size={42} />
          <AppText variant="section" numberOfLines={1} style={styles.peerName}>
            {currentThread.user.username}
          </AppText>
        </Pressable>

        <View style={[styles.notice, { backgroundColor: theme.infoSoft }]}>
          <AppText variant="caption">{t('messages.storedNotice')}</AppText>
        </View>

        {!currentThread.can_message ? (
          <View style={[styles.unavailable, { backgroundColor: theme.warningSoft }]}>
            <AppText variant="label">{t('messages.unavailable')}</AppText>
            <AppText variant="caption">{t('messages.unavailableHint')}</AppText>
          </View>
        ) : null}

        <FlatList
          inverted
          data={displayMessages}
          keyExtractor={(message) => message.id}
          contentContainerStyle={styles.messageList}
          keyboardShouldPersistTaps="handled"
          maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
          ListEmptyComponent={
            <EmptyState
              icon={MessageCircle}
              title={t('messages.noMessagesTitle')}
              message={t('messages.noMessagesMessage')}
            />
          }
          ListFooterComponent={
            thread.isFetchingNextPage ? (
              <LoadingState label={t('messages.loadingOlderMessages')} />
            ) : null
          }
          onEndReached={() => {
            if (thread.hasNextPage && !thread.isFetchingNextPage) {
              void thread.fetchNextPage();
            }
          }}
          onEndReachedThreshold={0.25}
          renderItem={({ item }) => {
            const own = item.sender_id === currentUser?.id;
            return (
              <MessageBubble
                message={item}
                own={own}
                isLastOwn={item.id === lastOwnMessageId}
                onReport={() => setReporting(item)}
              />
            );
          }}
        />

        <View style={[styles.composer, { borderTopColor: theme.border }]}>
          <View style={styles.inputCopy}>
            <TextInput
              accessibilityLabel={t('messages.inputLabel')}
              value={body}
              onChangeText={(value) => {
                setBody(clampMessageBody(value));
                sendMessage.reset();
              }}
              editable={currentThread.can_message && !sendMessage.isPending}
              multiline
              placeholder={t('messages.placeholder')}
              placeholderTextColor={theme.mutedText}
              textAlignVertical="top"
              style={[
                styles.input,
                {
                  color: theme.text,
                  borderColor: theme.border,
                  backgroundColor: theme.elevated,
                },
              ]}
            />
            <AppText variant="caption" muted style={styles.counter}>
              {messageCharacterCount(body)}/{MESSAGE_BODY_LIMIT}
            </AppText>
          </View>
          <AppButton
            compact
            label={t('messages.send')}
            icon={<Send color="#FFFFFF" size={18} />}
            loading={sendMessage.isPending}
            disabled={
              !currentThread.can_message || normalizeMessageBody(body).length === 0
            }
            onPress={submit}
          />
        </View>
        {sendMessage.error ? (
          <AppText variant="caption" style={[styles.sendError, { color: theme.danger }]}>
            {getErrorMessage(sendMessage.error, t('messages.sendError'))}
          </AppText>
        ) : null}
      </KeyboardAvoidingView>

      {reporting ? (
        <ReportSheet
          targetType="message"
          targetId={reporting.id}
          targetLabel={t('messages.reportTarget', {
            username: currentThread.user.username,
          })}
          onClose={() => setReporting(null)}
        />
      ) : null}
    </SafeAreaView>
  );
}

function MessageBubble({
  message,
  own,
  isLastOwn,
  onReport,
}: {
  message: DirectMessage;
  own: boolean;
  isLastOwn: boolean;
  onReport: () => void;
}) {
  const theme = useTheme();
  const t = useT();
  return (
    <View style={[styles.bubbleRow, own ? styles.ownRow : styles.incomingRow]}>
      {!own ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('messages.reportMessage')}
          hitSlop={8}
          onPress={onReport}
          style={({ pressed }) => [styles.report, { opacity: pressed ? 0.55 : 1 }]}
        >
          <Flag color={theme.danger} size={16} />
        </Pressable>
      ) : null}
      <View
        style={[
          styles.bubble,
          own ? styles.ownBubble : styles.incomingBubble,
          { backgroundColor: own ? theme.primary : theme.surface },
        ]}
      >
        <AppText style={own ? styles.ownText : undefined}>{message.body}</AppText>
        <View style={styles.messageMeta}>
          <AppText
            variant="caption"
            style={own ? styles.ownMeta : { color: theme.mutedText }}
          >
            {formatDateTime(message.created_at)}
          </AppText>
          {own && isLastOwn ? (
            <AppText variant="caption" style={styles.ownMeta}>
              {message.read_at ? t('messages.read') : t('messages.sent')}
            </AppText>
          ) : null}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  peerHeader: {
    minHeight: 62,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.lg,
  },
  peerName: { flex: 1 },
  notice: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  unavailable: { gap: spacing.xs, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  messageList: {
    flexGrow: 1,
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.lg,
  },
  bubbleRow: { width: '100%', flexDirection: 'row', alignItems: 'flex-end', gap: spacing.xs },
  ownRow: { justifyContent: 'flex-end' },
  incomingRow: { justifyContent: 'flex-start' },
  bubble: { maxWidth: '82%', paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  ownBubble: { borderRadius: radius.lg, borderBottomRightRadius: radius.sm },
  incomingBubble: { borderRadius: radius.lg, borderBottomLeftRadius: radius.sm },
  ownText: { color: '#FFFFFF' },
  messageMeta: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  ownMeta: { color: 'rgba(255, 255, 255, 0.78)' },
  report: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
  },
  inputCopy: { flex: 1, minWidth: 0 },
  input: {
    minHeight: 46,
    maxHeight: 120,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.lg,
    fontSize: 15,
    lineHeight: 20,
  },
  counter: { position: 'absolute', right: spacing.sm, bottom: spacing.xs },
  sendError: { paddingHorizontal: spacing.md, paddingBottom: spacing.sm },
});
