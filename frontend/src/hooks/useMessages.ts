import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';

import api from '@/lib/api';
import { fetchPeerKeys } from '@/lib/crypto/session';
import { encryptionKeys } from '@/hooks/useEncryption';
import { useEncryptionStore } from '@/store/encryption';
import type {
  DirectMessage,
  MessageConversation,
  MessageSummary,
  MessageThread,
} from '@/types';

// Kept as a safety net rather than removed. The event stream is the primary
// signal now, but SSE is the kind of thing a corporate proxy or a captive
// portal quietly breaks, and a client that only listens would then look
// permanently up to date while showing nothing new. A slow poll makes that
// failure a delay instead of silence.
const EVENT_STREAM_FALLBACK_MS = 120_000;

const CONVERSATION_PAGE_SIZE = 30;
const THREAD_PAGE_SIZE = 50;

interface MessageCursor {
  before: string;
  beforeId: string;
}

export const messageKeys = {
  all: ['messages'] as const,
  summary: ['messages', 'summary'] as const,
  conversations: ['messages', 'conversations'] as const,
  thread: (username: string) => ['messages', 'thread', username.toLowerCase()] as const,
};

export function useMessageSummary(enabled = true) {
  return useQuery<MessageSummary>({
    queryKey: messageKeys.summary,
    queryFn: async () => {
      const response = await api.get<MessageSummary>('/messages/summary');
      return response.data;
    },
    enabled,
    refetchInterval: EVENT_STREAM_FALLBACK_MS,
  });
}

export function useMessageConversations(enabled = true) {
  return useInfiniteQuery({
    queryKey: messageKeys.conversations,
    queryFn: async ({ pageParam }) => {
      const response = await api.get<MessageConversation[]>('/messages', {
        params: { page: pageParam, limit: CONVERSATION_PAGE_SIZE },
      });
      return response.data;
    },
    initialPageParam: 1,
    getNextPageParam: (lastPage, pages) =>
      lastPage.length === CONVERSATION_PAGE_SIZE ? pages.length + 1 : undefined,
    enabled,
    refetchInterval: EVENT_STREAM_FALLBACK_MS,
  });
}

export function useMessageThread(username: string) {
  return useInfiniteQuery({
    queryKey: messageKeys.thread(username),
    queryFn: async ({ pageParam }) => {
      const cursor = pageParam as MessageCursor | null;
      const response = await api.get<MessageThread>(
        `/messages/${encodeURIComponent(username)}`,
        {
          params: {
            limit: THREAD_PAGE_SIZE,
            ...(cursor && { before: cursor.before, before_id: cursor.beforeId }),
          },
        },
      );
      return response.data;
    },
    initialPageParam: null as MessageCursor | null,
    getNextPageParam: (lastPage) => {
      const firstMessage = lastPage.messages[0];
      if (lastPage.messages.length < THREAD_PAGE_SIZE || !firstMessage) return undefined;
      return { before: firstMessage.created_at, beforeId: firstMessage.id };
    },
    enabled: Boolean(username),
    refetchInterval: EVENT_STREAM_FALLBACK_MS,
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

      // Imported here rather than at the top of the file: the navbar pulls this
      // module in for the unread badge, and the primitives are a third of a
      // megabyte that a reader who never sends a message should not download.
      const payload =
        peer && identity
          ? {
              ...(await import('@/lib/crypto/messages')).sealMessage(
                body,
                peer,
                identity,
                clientNonce,
              ),
              client_nonce: clientNonce,
            }
          : { body, client_nonce: clientNonce };

      const response = await api.post<DirectMessage>(
        `/messages/${encodeURIComponent(username)}`,
        payload,
      );
      return response.data;
    },
    onSuccess: (_message, variables) => {
      void queryClient.invalidateQueries({ queryKey: messageKeys.thread(variables.username) });
      void queryClient.invalidateQueries({ queryKey: messageKeys.conversations });
      void queryClient.invalidateQueries({ queryKey: messageKeys.summary });
    },
  });
}

export function useMarkMessageThreadRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ username, throughId }: { username: string; throughId: string }) => {
      await api.post(`/messages/${encodeURIComponent(username)}/read`, {
        through_id: throughId,
      });
    },
    onSuccess: (_response, variables) => {
      void queryClient.invalidateQueries({ queryKey: messageKeys.thread(variables.username) });
      void queryClient.invalidateQueries({ queryKey: messageKeys.conversations });
      void queryClient.invalidateQueries({ queryKey: messageKeys.summary });
    },
  });
}
