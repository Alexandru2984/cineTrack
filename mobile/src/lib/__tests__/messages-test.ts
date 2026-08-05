import {
  clampMessageBody,
  messageCharacterCount,
  MESSAGE_BODY_LIMIT,
  MESSAGE_THREAD_PAGE_SIZE,
  nextMessageCursor,
  nonceForMessage,
  normalizeMessageBody,
  uniqueConversations,
  uniqueThreadMessages,
} from '@/lib/messages';
import type { DirectMessage, MessageConversation, MessageThread } from '@/types';

function message(id: string, createdAt: string): DirectMessage {
  return {
    id,
    sender_id: 'sender',
    recipient_id: 'recipient',
    body: id,
    read_at: null,
    created_at: createdAt,
  };
}

function thread(messages: DirectMessage[]): MessageThread {
  return {
    user: { id: 'peer', username: 'peer', avatar_url: null },
    can_message: true,
    messages,
  };
}

function conversation(userId: string): MessageConversation {
  return {
    user_id: userId,
    username: userId,
    avatar_url: null,
    last_message_id: `message-${userId}`,
    last_message_sender_id: 'sender',
    last_message_body: 'hello',
    last_message_at: '2026-08-05T12:00:00Z',
    last_message_read_at: null,
    unread_count: 0,
    can_message: true,
  };
}

describe('mobile direct-message helpers', () => {
  it('normalizes whitespace without interpreting message markup', () => {
    expect(normalizeMessageBody('  <img src=x onerror=alert(1)>\r\nhello  ')).toBe(
      '<img src=x onerror=alert(1)>\nhello',
    );
  });

  it('counts and limits Unicode code points like the backend', () => {
    expect(messageCharacterCount('🎬🎬')).toBe(2);
    expect(clampMessageBody(`🎬${'x'.repeat(MESSAGE_BODY_LIMIT)}`)).toBe(
      `🎬${'x'.repeat(MESSAGE_BODY_LIMIT - 1)}`,
    );
  });

  it('orders older pages first and removes duplicate messages', () => {
    const oldest = message('one', '2026-08-05T10:00:00Z');
    const middle = message('two', '2026-08-05T11:00:00Z');
    const newest = message('three', '2026-08-05T12:00:00Z');

    expect(
      uniqueThreadMessages([
        thread([middle, newest]),
        thread([oldest, middle]),
      ]).map((item) => item.id),
    ).toEqual(['one', 'two', 'three']);
  });

  it('builds a keyset cursor only for a full message page', () => {
    const messages = Array.from({ length: MESSAGE_THREAD_PAGE_SIZE }, (_, index) =>
      message(String(index), `2026-08-05T10:${String(index).padStart(2, '0')}:00Z`),
    );
    expect(nextMessageCursor(thread(messages))).toEqual({
      before: messages[0].created_at,
      beforeId: messages[0].id,
    });
    expect(nextMessageCursor(thread(messages.slice(1)))).toBeUndefined();
  });

  it('keeps the first conversation when pages overlap', () => {
    expect(
      uniqueConversations([
        [conversation('alice'), conversation('bob')],
        [conversation('bob'), conversation('carol')],
      ]).map((item) => item.user_id),
    ).toEqual(['alice', 'bob', 'carol']);
  });

  it('reuses the nonce only when retrying the same normalized body', () => {
    const createNonce = jest.fn(() => 'new-nonce');
    expect(
      nonceForMessage('hello', { body: 'hello', nonce: 'retry-nonce' }, createNonce),
    ).toBe('retry-nonce');
    expect(nonceForMessage('changed', { body: 'hello', nonce: 'retry-nonce' }, createNonce))
      .toBe('new-nonce');
    expect(createNonce).toHaveBeenCalledTimes(1);
  });
});
