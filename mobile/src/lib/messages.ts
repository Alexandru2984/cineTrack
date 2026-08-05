import type { DirectMessage, MessageConversation, MessageThread } from '@/types';

export const MESSAGE_BODY_LIMIT = 2_000;
export const MESSAGE_CONVERSATION_PAGE_SIZE = 30;
export const MESSAGE_THREAD_PAGE_SIZE = 50;

export interface MessageCursor {
  before: string;
  beforeId: string;
}

export interface MessageRetry {
  body: string;
  nonce: string;
}

export function normalizeMessageBody(value: string) {
  return value.replace(/\r\n?/g, '\n').trim();
}

export function messageCharacterCount(value: string) {
  return Array.from(value).length;
}

export function clampMessageBody(value: string) {
  return Array.from(value).slice(0, MESSAGE_BODY_LIMIT).join('');
}

export function nextMessageCursor(page: MessageThread): MessageCursor | undefined {
  const firstMessage = page.messages[0];
  if (page.messages.length < MESSAGE_THREAD_PAGE_SIZE || !firstMessage) {
    return undefined;
  }
  return { before: firstMessage.created_at, beforeId: firstMessage.id };
}

export function uniqueThreadMessages(pages: readonly MessageThread[]): DirectMessage[] {
  const seen = new Set<string>();
  return [...pages]
    .reverse()
    .flatMap((page) => page.messages)
    .filter((message) => {
      if (seen.has(message.id)) return false;
      seen.add(message.id);
      return true;
    });
}

export function uniqueConversations(
  pages: readonly MessageConversation[][],
): MessageConversation[] {
  const seen = new Set<string>();
  return pages.flatMap((page) =>
    page.filter((conversation) => {
      if (seen.has(conversation.user_id)) return false;
      seen.add(conversation.user_id);
      return true;
    }),
  );
}

export function nonceForMessage(
  body: string,
  retry: MessageRetry | null,
  createNonce: () => string,
) {
  return retry?.body === body ? retry.nonce : createNonce();
}
