import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';

import { apiRequest } from '@/lib/api';
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
    refetchInterval: poll ? 30_000 : false,
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
    refetchInterval: enabled ? 20_000 : false,
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
    refetchInterval: enabled && username.length > 0 ? 10_000 : false,
  });
}

export function useSendMessage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      username,
      body,
      clientNonce,
    }: {
      username: string;
      body: string;
      clientNonce: string;
    }) =>
      apiRequest<DirectMessage>(`/messages/${encodeURIComponent(username)}`, {
        method: 'POST',
        body: { body, client_nonce: clientNonce },
      }),
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
