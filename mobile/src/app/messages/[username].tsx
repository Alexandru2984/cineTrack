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
import { EncryptionGate } from '@/components/encryption-gate';
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
import { usePeerKeys } from '@/hooks/use-encryption';
import { useT } from '@/hooks/use-t';
import { useTheme } from '@/hooks/use-theme';
import { messagePath, safePostAuthRedirect } from '@/lib/deep-links';
import { readMessage, type MessageContent } from '@/lib/crypto/messages';
import { formatDateTime } from '@/lib/format';
import { getErrorMessage } from '@/lib/http';
import { safetyNumber, toHex } from '@/lib/crypto/core';
import { useEncryptionStore } from '@/store/encryption';
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
  const identity = useEncryptionStore((state) => state.identity);
  const encryptionStatus = useEncryptionStore((state) => state.status);
  const [showingSafetyNumber, setShowingSafetyNumber] = useState(false);
  const lastReadRequest = useRef<string | null>(null);

  // Both fingerprints, combined into the one string the two people compare.
  // Absent unless both sides have published keys: there is nothing to compare
  // until then, and offering the check would imply a protection not in place.
  const ownFingerprint = useEncryptionStore((state) => state.fingerprint);
  const peerKeys = usePeerKeys(username, Boolean(username));
  const safetyNumberValue =
    ownFingerprint && peerKeys.data
      ? safetyNumber(ownFingerprint, peerKeys.data.key_fingerprint)
      : null;

  /** The evidence a report needs, for a message only this device can read.
   *
   *  Absent for a plaintext message, and absent — deliberately — for one that
   *  could not be decrypted: a report without the key that opens the sender's
   *  commitment would be refused, and offering a form that cannot succeed is
   *  worse than refusing it here. */
  const reportEvidence = (message: DirectMessage) => {
    const content = readMessage(message, identity);
    if (content.kind !== 'encrypted') return undefined;
    return {
      revealedPlaintext: content.content.text,
      frankingKey: toHex(content.content.frankingKey),
    };
  };
  const messages = useMemo(
    () => uniqueThreadMessages(thread.data?.pages ?? []),
    [thread.data],
  );

  // True when anything in this thread arrived encrypted. Derived from the
  // messages rather than from the peer's key, so the notice describes what the
  // user is actually looking at instead of what a future message would be.
  const threadIsEncrypted = messages.some((message) => message.body === null);
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
          <AppText variant="caption">
            {threadIsEncrypted
              ? t('messages.privacyNoticeEncrypted')
              : t('messages.storedNotice')}
          </AppText>
          {safetyNumberValue ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('encryption.safetyNumber')}
              accessibilityState={{ expanded: showingSafetyNumber }}
              onPress={() => setShowingSafetyNumber((showing) => !showing)}
            >
              <AppText variant="caption" style={{ color: theme.primary }}>
                {t('encryption.safetyNumber')}
              </AppText>
            </Pressable>
          ) : null}
          {safetyNumberValue && showingSafetyNumber ? (
            <>
              <AppText selectable style={styles.safetyNumber}>
                {safetyNumberValue}
              </AppText>
              <AppText variant="caption" style={{ color: theme.mutedText }}>
                {t('encryption.safetyNumberHint')}
              </AppText>
            </>
          ) : null}
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
                content={readMessage(item, identity)}
                own={own}
                isLastOwn={item.id === lastOwnMessageId}
                onReport={() => setReporting(item)}
              />
            );
          }}
        />

        {/* Above the composer rather than over the thread: whatever the user
            has to do about their key, they should still be able to read what
            is already readable while they do it. */}
        {encryptionStatus !== 'ready' ? (
          <View style={styles.gate}>
            <EncryptionGate />
          </View>
        ) : null}

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
          evidence={reportEvidence(reporting)}
          targetLabel={t('messages.reportTarget', {
            username: currentThread.user.username,
          })}
          onClose={() => setReporting(null)}
        />
      ) : null}
    </SafeAreaView>
  );
}

/** What to show for a message, in the four states one can be in.
 *
 *  The two failure states are kept distinct on purpose: "locked" is something
 *  the user can fix by restoring their key, "undecryptable" is not. */
function previewText(
  content: MessageContent,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  switch (content.kind) {
    case 'plain':
      return content.text;
    case 'encrypted':
      return content.content.text;
    case 'locked':
      return t('messages.lockedPreview');
    default:
      return t('messages.undecryptable');
  }
}

function MessageBubble({
  message,
  content,
  own,
  isLastOwn,
  onReport,
}: {
  message: DirectMessage;
  content: MessageContent;
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
        <AppText style={own ? styles.ownText : undefined}>{previewText(content, t)}</AppText>
        {content.kind === 'encrypted' && !content.content.commitmentVerified ? (
          <AppText variant="caption" style={own ? styles.ownMeta : { color: theme.mutedText }}>
            {t('messages.commitmentMismatch')}
          </AppText>
        ) : null}
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
  gate: { paddingHorizontal: spacing.md, paddingBottom: spacing.sm },
  safetyNumber: { fontFamily: 'monospace' },
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
