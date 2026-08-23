import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';

import { apiRequest } from '@/lib/api';
import { sealMessage } from '@/lib/crypto/messages';
import { fetchPeerKeys } from '@/lib/crypto/session';
import { encryptionKeys } from '@/hooks/use-encryption';
import { useEncryptionStore } from '@/store/encryption';
import { withQuery } from '@/lib/http';
import {
  MESSAGE_CONVERSATION_PAGE_SIZE,
  MESSAGE_THREAD_PAGE_SIZE,
  nextMessageCursor,
  type MessageCursor,
} from '@/lib/messages';
import type {
  DirectMessage,
  MessageConversation,
  MessageSummary,
  MessageThread,
} from '@/types';

// Kept as a safety net rather than removed. The event stream is the primary
// signal now, but a captive portal or a restrictive mobile network can break a
// long-lived connection without breaking ordinary requests — and a client that
// only listens would then look permanently up to date while showing nothing
// new. A slow poll makes that failure a delay instead of silence.
const EVENT_STREAM_FALLBACK_MS = 120_000;

export const messageKeys = {
  all: ['messages'] as const,
  summary: ['messages', 'summary'] as const,
  conversations: ['messages', 'conversations'] as const,
  thread: (username: string) =>
    ['messages', 'thread', username.toLowerCase()] as const,
};

export function useMessageSummary(enabled = true, poll = false) {
  return useQuery({
    queryKey: messageKeys.summary,
    queryFn: ({ signal }) =>
      apiRequest<MessageSummary>('/messages/summary', { signal }),
    enabled,
    refetchInterval: poll ? EVENT_STREAM_FALLBACK_MS : false,
  });
}

export function useMessageConversations(enabled = true) {
  return useInfiniteQuery({
    queryKey: messageKeys.conversations,
    queryFn: ({ pageParam, signal }) =>
      apiRequest<MessageConversation[]>(
        withQuery('/messages', {
          page: pageParam,
          limit: MESSAGE_CONVERSATION_PAGE_SIZE,
        }),
        { signal },
      ),
    initialPageParam: 1,
    getNextPageParam: (lastPage, pages) =>
      lastPage.length === MESSAGE_CONVERSATION_PAGE_SIZE
        ? pages.length + 1
        : undefined,
    enabled,
    refetchInterval: enabled ? EVENT_STREAM_FALLBACK_MS : false,
  });
}

export function useMessageThread(username: string, enabled = true) {
  return useInfiniteQuery({
    queryKey: messageKeys.thread(username),
    queryFn: ({ pageParam, signal }) => {
      const cursor = pageParam as MessageCursor | null;
      return apiRequest<MessageThread>(
        withQuery(`/messages/${encodeURIComponent(username)}`, {
          limit: MESSAGE_THREAD_PAGE_SIZE,
          before: cursor?.before,
          before_id: cursor?.beforeId,
        }),
        { signal },
      );
    },
    initialPageParam: null as MessageCursor | null,
    getNextPageParam: nextMessageCursor,
    enabled: enabled && username.length > 0,
    refetchInterval:
      enabled && username.length > 0 ? EVENT_STREAM_FALLBACK_MS : false,
  });
}

export class EncryptionRequiredError extends Error {
  constructor() {
    super('encryption-required');
    this.name = 'EncryptionRequiredError';
  }
}

export function useSendMessage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      username,
      body,
      clientNonce,
    }: {
      username: string;
      body: string;
      clientNonce: string;
    }) => {
      // Whether to encrypt is decided by whether the recipient can decrypt,
      // which is a fact about the directory rather than a preference. The
      // server re-derives the same rule, so a client that guessed wrong is
      // refused rather than quietly downgraded.
      const peer = await queryClient.fetchQuery({
        queryKey: encryptionKeys.peer(username),
        queryFn: () => fetchPeerKeys(username),
        staleTime: 5 * 60 * 1000,
      });
      const identity = useEncryptionStore.getState().identity;

      if (peer && !identity) {
        // The recipient expects encryption and this device cannot provide it.
        // Sending in the clear would be refused by the server anyway, and
        // saying so here explains what to do about it.
        throw new EncryptionRequiredError();
      }

      const payload =
        peer && identity
          ? { ...sealMessage(body, peer, identity, clientNonce), client_nonce: clientNonce }
          : { body, client_nonce: clientNonce };

      return apiRequest<DirectMessage>(`/messages/${encodeURIComponent(username)}`, {
        method: 'POST',
        body: payload,
      });
    },
    onSuccess: (_message, variables) => {
      void queryClient.invalidateQueries({
        queryKey: messageKeys.thread(variables.username),
      });
      void queryClient.invalidateQueries({ queryKey: messageKeys.conversations });
      void queryClient.invalidateQueries({ queryKey: messageKeys.summary });
    },
  });
}

export function useMarkMessageThreadRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ username, throughId }: { username: string; throughId: string }) =>
      apiRequest(`/messages/${encodeURIComponent(username)}/read`, {
        method: 'POST',
        body: { through_id: throughId },
      }),
    onSuccess: (_response, variables) => {
      void queryClient.invalidateQueries({
        queryKey: messageKeys.thread(variables.username),
      });
      void queryClient.invalidateQueries({ queryKey: messageKeys.conversations });
      void queryClient.invalidateQueries({ queryKey: messageKeys.summary });
    },
  });
}
