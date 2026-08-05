import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import {
  ArrowLeft,
  Flag,
  Loader2,
  MessageCircle,
  Send,
  ShieldAlert,
  User,
} from 'lucide-react';

import { LoadingSpinner } from '@/components/LoadingSpinner';
import { ReportDialog } from '@/components/ReportDialog';
import {
  useMarkMessageThreadRead,
  useMessageConversations,
  useMessageThread,
  useSendMessage,
} from '@/hooks/useMessages';
import { usePageTitle } from '@/hooks/usePageTitle';
import { useT } from '@/hooks/useT';
import { getApiErrorMessage } from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { useLocaleStore } from '@/store/locale';
import type { DirectMessage, MessageConversation } from '@/types';

const MAX_MESSAGE_CHARACTERS = 2_000;

function createClientNonce(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hexadecimal = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hexadecimal.slice(0, 8)}-${hexadecimal.slice(8, 12)}-${hexadecimal.slice(12, 16)}-${hexadecimal.slice(16, 20)}-${hexadecimal.slice(20)}`;
}

function messageTime(value: string, locale: 'en' | 'ro', includeDate = false) {
  return new Intl.DateTimeFormat(locale === 'ro' ? 'ro-RO' : 'en-US', {
    ...(includeDate && { month: 'short', day: 'numeric' }),
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function ConversationAvatar({
  username,
  avatarUrl,
}: {
  username: string;
  avatarUrl: string | null;
}) {
  return avatarUrl ? (
    <img
      src={avatarUrl}
      alt=""
      loading="lazy"
      className="h-11 w-11 shrink-0 rounded-full object-cover"
    />
  ) : (
    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[hsl(var(--primary))]/15 text-[hsl(var(--primary))]">
      <User className="h-5 w-5" aria-hidden="true" />
      <span className="sr-only">{username}</span>
    </span>
  );
}

function ConversationRow({
  conversation,
  currentUserId,
  selected,
  locale,
  t,
}: {
  conversation: MessageConversation;
  currentUserId: string | undefined;
  selected: boolean;
  locale: 'en' | 'ro';
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const preview = conversation.last_message_sender_id === currentUserId
    ? `${t('messages.you')}: ${conversation.last_message_body}`
    : conversation.last_message_body;

  return (
    <Link
      to={`/messages/${encodeURIComponent(conversation.username)}`}
      aria-label={t('messages.openConversation', { username: conversation.username })}
      aria-current={selected ? 'page' : undefined}
      className={`flex min-w-0 gap-3 border-b border-[hsl(var(--border))] px-4 py-3 transition-colors last:border-b-0 hover:bg-[hsl(var(--accent))] ${
        selected ? 'bg-[hsl(var(--accent))]' : ''
      }`}
    >
      <ConversationAvatar
        username={conversation.username}
        avatarUrl={conversation.avatar_url}
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-start justify-between gap-2">
          <strong className="truncate text-sm">{conversation.username}</strong>
          <time
            dateTime={conversation.last_message_at}
            className="shrink-0 text-[11px] text-[hsl(var(--muted-foreground))]"
          >
            {messageTime(conversation.last_message_at, locale, true)}
          </time>
        </span>
        <span className="mt-1 flex min-w-0 items-center gap-2">
          <span
            className={`min-w-0 flex-1 truncate text-xs ${
              conversation.unread_count > 0
                ? 'font-medium text-[hsl(var(--foreground))]'
                : 'text-[hsl(var(--muted-foreground))]'
            }`}
          >
            {preview}
          </span>
          {conversation.unread_count > 0 ? (
            <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-[hsl(var(--primary))] px-1.5 text-[10px] font-semibold text-[hsl(var(--primary-foreground))]">
              {conversation.unread_count > 99 ? '99+' : conversation.unread_count}
            </span>
          ) : null}
        </span>
      </span>
    </Link>
  );
}

function MessageBubble({
  message,
  own,
  locale,
  isLastOwn,
  onReport,
  t,
}: {
  message: DirectMessage;
  own: boolean;
  locale: 'en' | 'ro';
  isLastOwn: boolean;
  onReport: () => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  return (
    <article className={`group flex ${own ? 'justify-end' : 'justify-start'}`}>
      <div className={`flex max-w-[88%] items-end gap-1 sm:max-w-[75%] ${own ? 'flex-row-reverse' : ''}`}>
        <div
          className={`min-w-0 rounded-2xl px-3 py-2 ${
            own
              ? 'rounded-br-sm bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]'
              : 'rounded-bl-sm bg-[hsl(var(--muted))] text-[hsl(var(--foreground))]'
          }`}
        >
          <p className="whitespace-pre-wrap break-words text-sm leading-5">{message.body}</p>
          <div
            className={`mt-1 flex items-center justify-end gap-1.5 text-[10px] ${
              own ? 'opacity-75' : 'text-[hsl(var(--muted-foreground))]'
            }`}
          >
            <time dateTime={message.created_at} title={new Date(message.created_at).toLocaleString()}>
              {messageTime(message.created_at, locale)}
            </time>
            {own && isLastOwn ? (
              <span>{message.read_at ? t('messages.read') : t('messages.sent')}</span>
            ) : null}
          </div>
        </div>
        {!own ? (
          <button
            type="button"
            onClick={onReport}
            aria-label={t('messages.reportMessage')}
            title={t('safety.report')}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-[hsl(var(--muted-foreground))] opacity-70 transition-colors hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--destructive))] focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
          >
            <Flag className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </article>
  );
}

export default function MessagesPage() {
  const { username = '' } = useParams<{ username: string }>();
  return <MessagesContent key={username.toLowerCase()} username={username} />;
}

function MessagesContent({ username }: { username: string }) {
  const t = useT();
  const locale = useLocaleStore((state) => state.locale);
  const currentUser = useAuthStore((state) => state.user);
  const conversations = useMessageConversations();
  const thread = useMessageThread(username);
  const sendMessage = useSendMessage();
  const { mutate: markRead, isPending: isMarkingRead } = useMarkMessageThreadRead();
  const [body, setBody] = useState('');
  const [retry, setRetry] = useState<{ body: string; nonce: string } | null>(null);
  const [reporting, setReporting] = useState<DirectMessage | null>(null);
  const messageListRef = useRef<HTMLDivElement>(null);
  const lastVisibleMessageRef = useRef<string | null>(null);
  const lastReadRequestRef = useRef<string | null>(null);

  const conversationItems = useMemo(
    () => conversations.data?.pages.flatMap((page) => page) ?? [],
    [conversations.data],
  );
  const messages = useMemo(
    () => [...(thread.data?.pages ?? [])].reverse().flatMap((page) => page.messages),
    [thread.data],
  );
  const currentThread = thread.data?.pages[0];
  const lastMessage = messages.at(-1);
  const lastOwnMessageId = [...messages]
    .reverse()
    .find((message) => message.sender_id === currentUser?.id)?.id;
  const newestUnreadIncoming = [...messages]
    .reverse()
    .find((message) => message.recipient_id === currentUser?.id && message.read_at === null);

  usePageTitle(username ? `@${currentThread?.user.username ?? username}` : t('messages.title'));

  useEffect(() => {
    if (!newestUnreadIncoming || isMarkingRead) return;
    if (lastReadRequestRef.current === newestUnreadIncoming.id) return;

    lastReadRequestRef.current = newestUnreadIncoming.id;
    markRead(
      { username, throughId: newestUnreadIncoming.id },
      { onError: () => { lastReadRequestRef.current = null; } },
    );
  }, [isMarkingRead, markRead, newestUnreadIncoming, username]);

  useEffect(() => {
    if (!lastMessage || lastVisibleMessageRef.current === lastMessage.id) return;
    const behavior = lastVisibleMessageRef.current === null ? 'auto' : 'smooth';
    lastVisibleMessageRef.current = lastMessage.id;
    messageListRef.current?.scrollTo?.({
      top: messageListRef.current.scrollHeight,
      behavior,
    });
  }, [lastMessage]);

  const submitMessage = (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    const normalizedBody = body.trim();
    if (!username || !normalizedBody || sendMessage.isPending) return;

    const nonce = retry?.body === normalizedBody ? retry.nonce : createClientNonce();
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
    <div className="mx-auto flex h-[calc(100dvh-8.5rem-env(safe-area-inset-bottom))] min-h-[32rem] w-full max-w-6xl gap-4 px-4 py-4 md:h-[calc(100dvh-6rem)] md:px-6 md:py-6">
      <section
        aria-label={t('messages.conversations')}
        className={`${username ? 'hidden lg:flex' : 'flex'} w-full min-w-0 flex-col overflow-hidden rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] lg:w-80 lg:shrink-0`}
      >
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-[hsl(var(--border))] px-4">
          <MessageCircle className="h-5 w-5 text-[hsl(var(--primary))]" aria-hidden="true" />
          <h1 className="text-lg font-semibold">{t('messages.title')}</h1>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {conversations.isLoading ? <LoadingSpinner /> : null}
          {conversations.isError ? (
            <p className="p-5 text-sm text-[hsl(var(--destructive))]" role="alert">
              {t('messages.loadError')}
            </p>
          ) : null}
          {!conversations.isLoading && !conversations.isError && conversationItems.length === 0 ? (
            <div className="p-6 text-center">
              <MessageCircle
                className="mx-auto h-8 w-8 text-[hsl(var(--muted-foreground))]"
                aria-hidden="true"
              />
              <p className="mt-3 text-sm font-medium">{t('messages.empty')}</p>
              <p className="mt-1 text-xs leading-5 text-[hsl(var(--muted-foreground))]">
                {t('messages.emptyHint')}
              </p>
            </div>
          ) : null}
          {conversationItems.map((conversation) => (
            <ConversationRow
              key={conversation.user_id}
              conversation={conversation}
              currentUserId={currentUser?.id}
              selected={conversation.username.toLowerCase() === username.toLowerCase()}
              locale={locale}
              t={t}
            />
          ))}
          {conversations.hasNextPage ? (
            <button
              type="button"
              disabled={conversations.isFetchingNextPage}
              onClick={() => conversations.fetchNextPage()}
              className="flex h-11 w-full items-center justify-center gap-2 border-t border-[hsl(var(--border))] text-sm font-medium hover:bg-[hsl(var(--accent))] disabled:opacity-50"
            >
              {conversations.isFetchingNextPage ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : null}
              {t('common.loadMore')}
            </button>
          ) : null}
        </div>
      </section>

      <section
        aria-label={username ? t('messages.threadWith', { username }) : t('messages.thread')}
        className={`${username ? 'flex' : 'hidden lg:flex'} min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))]`}
      >
        {!username ? (
          <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
            <MessageCircle
              className="h-10 w-10 text-[hsl(var(--muted-foreground))]"
              aria-hidden="true"
            />
            <p className="mt-4 font-medium">{t('messages.select')}</p>
          </div>
        ) : thread.isLoading ? (
          <LoadingSpinner />
        ) : thread.isError || !currentThread ? (
          <div className="flex flex-1 flex-col items-center justify-center p-6 text-center">
            <p className="text-sm text-[hsl(var(--destructive))]" role="alert">
              {getApiErrorMessage(thread.error, t('messages.threadLoadError'))}
            </p>
            <Link
              to="/messages"
              className="mt-4 rounded-md border border-[hsl(var(--border))] px-4 py-2 text-sm font-medium lg:hidden"
            >
              {t('messages.back')}
            </Link>
          </div>
        ) : (
          <>
            <header className="flex h-14 shrink-0 items-center gap-3 border-b border-[hsl(var(--border))] px-3 sm:px-4">
              <Link
                to="/messages"
                aria-label={t('messages.back')}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md hover:bg-[hsl(var(--accent))] lg:hidden"
              >
                <ArrowLeft className="h-5 w-5" aria-hidden="true" />
              </Link>
              <ConversationAvatar
                username={currentThread.user.username}
                avatarUrl={currentThread.user.avatar_url}
              />
              <Link
                to={`/profile/${encodeURIComponent(currentThread.user.username)}`}
                className="min-w-0 truncate font-semibold hover:text-[hsl(var(--primary))] hover:underline"
              >
                {currentThread.user.username}
              </Link>
            </header>

            <div
              ref={messageListRef}
              className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-3 py-4 sm:px-5"
              aria-live="polite"
            >
              {thread.hasNextPage ? (
                <div className="text-center">
                  <button
                    type="button"
                    disabled={thread.isFetchingNextPage}
                    onClick={() => thread.fetchNextPage()}
                    className="inline-flex h-9 items-center gap-2 rounded-md border border-[hsl(var(--border))] px-3 text-xs font-medium hover:bg-[hsl(var(--accent))] disabled:opacity-50"
                  >
                    {thread.isFetchingNextPage ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                    ) : null}
                    {t('messages.loadOlder')}
                  </button>
                </div>
              ) : null}
              {messages.length === 0 ? (
                <div className="flex min-h-full flex-col items-center justify-center text-center">
                  <MessageCircle
                    className="h-9 w-9 text-[hsl(var(--muted-foreground))]"
                    aria-hidden="true"
                  />
                  <p className="mt-3 text-sm font-medium">{t('messages.noMessages')}</p>
                  <p className="mt-1 max-w-sm text-xs leading-5 text-[hsl(var(--muted-foreground))]">
                    {t('messages.noMessagesHint')}
                  </p>
                </div>
              ) : null}
              {messages.map((message) => (
                <MessageBubble
                  key={message.id}
                  message={message}
                  own={message.sender_id === currentUser?.id}
                  locale={locale}
                  isLastOwn={message.id === lastOwnMessageId}
                  onReport={() => setReporting(message)}
                  t={t}
                />
              ))}
            </div>

            {currentThread.can_message ? (
              <form
                onSubmit={submitMessage}
                className="shrink-0 border-t border-[hsl(var(--border))] p-3 sm:p-4"
              >
                <div className="flex items-end gap-2">
                  <div className="min-w-0 flex-1">
                    <label htmlFor="message-composer" className="sr-only">
                      {t('messages.inputLabel')}
                    </label>
                    <textarea
                      id="message-composer"
                      rows={1}
                      maxLength={MAX_MESSAGE_CHARACTERS}
                      value={body}
                      onChange={(event) => {
                        setBody(event.target.value);
                        if (retry && event.target.value.trim() !== retry.body) setRetry(null);
                      }}
                      onKeyDown={(event) => {
                        if (
                          event.key === 'Enter'
                          && !event.shiftKey
                          && !event.nativeEvent.isComposing
                        ) {
                          event.preventDefault();
                          submitMessage();
                        }
                      }}
                      placeholder={t('messages.placeholder')}
                      className="max-h-36 min-h-11 w-full resize-none rounded-md border border-[hsl(var(--input))] bg-transparent px-3 py-2.5 text-sm outline-none focus:border-[hsl(var(--primary))]"
                    />
                    <span className="mt-1 block text-right text-[10px] text-[hsl(var(--muted-foreground))]">
                      {body.length}/{MAX_MESSAGE_CHARACTERS}
                    </span>
                  </div>
                  <button
                    type="submit"
                    disabled={!body.trim() || sendMessage.isPending}
                    aria-label={t('messages.send')}
                    className="mb-4 flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] disabled:opacity-50"
                  >
                    {sendMessage.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <Send className="h-4 w-4" aria-hidden="true" />
                    )}
                  </button>
                </div>
                {sendMessage.error ? (
                  <p className="mt-1 text-xs text-[hsl(var(--destructive))]" role="alert">
                    {getApiErrorMessage(sendMessage.error, t('messages.sendError'))}
                  </p>
                ) : null}
                <p className="mt-1 flex items-start gap-1.5 text-[10px] leading-4 text-[hsl(var(--muted-foreground))]">
                  <ShieldAlert className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                  {t('messages.privacyNotice')}
                </p>
              </form>
            ) : (
              <div className="shrink-0 border-t border-[hsl(var(--border))] bg-[hsl(var(--muted))]/45 px-4 py-3">
                <p className="text-sm font-medium">{t('messages.unavailable')}</p>
                <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">
                  {t('messages.unavailableHint')}
                </p>
              </div>
            )}
          </>
        )}
      </section>

      {reporting && currentThread ? (
        <ReportDialog
          targetType="message"
          targetId={reporting.id}
          targetLabel={t('messages.reportTarget', { username: currentThread.user.username })}
          onClose={() => setReporting(null)}
        />
      ) : null}
    </div>
  );
}
