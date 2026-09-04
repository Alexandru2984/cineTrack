import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import api from '@/lib/api';
import type {
  PublicUserProfile,
  ActivityItem,
  UserSummary,
  FollowRequest,
  UserSearchResponse,
  BlockedUser,
} from '@/types';

export function useUserProfile(username: string) {
  return useQuery<PublicUserProfile>({
    queryKey: ['user', username],
    queryFn: async () => {
      const res = await api.get(`/users/${encodeURIComponent(username)}`);
      return res.data;
    },
    enabled: !!username,
  });
}

export function useUserActivity(username: string, enabled = true) {
  return useQuery<ActivityItem[]>({
    queryKey: ['activity', 'user', username],
    queryFn: async () => {
      const res = await api.get(`/users/${encodeURIComponent(username)}/activity`);
      return res.data;
    },
    enabled: !!username && enabled,
  });
}

export function useActivityFeed(limit = 10) {
  return useQuery<ActivityItem[]>({
    queryKey: ['activity', 'feed', limit],
    queryFn: async () => {
      const response = await api.get('/users/me/feed', { params: { limit } });
      return response.data;
    },
    staleTime: 30_000,
  });
}

export function useUserSearch(query: string, page = 1, limit = 20) {
  return useQuery<UserSearchResponse>({
    queryKey: ['user-search', query, page, limit],
    queryFn: async () => {
      const response = await api.get('/users/search', {
        params: { q: query, page, limit },
      });
      return response.data;
    },
    enabled: query.length >= 2,
    placeholderData: (previous) => previous,
  });
}

export function useFollow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (username: string) => {
      const response = await api.post<{ status: 'pending' | 'accepted' }>(
        `/users/${encodeURIComponent(username)}/follow`
      );
      return response.data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['user'] });
      void qc.invalidateQueries({ queryKey: ['user-search'] });
      void qc.invalidateQueries({ queryKey: ['activity', 'feed'] });
    },
  });
}

export function useUnfollow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (username: string) => {
      await api.delete(`/users/${encodeURIComponent(username)}/follow`);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['user'] });
      void qc.invalidateQueries({ queryKey: ['user-search'] });
      void qc.invalidateQueries({ queryKey: ['activity', 'feed'] });
    },
  });
}

export type UserConnectionKind = 'followers' | 'following';

const CONNECTIONS_PAGE_SIZE = 50;

export function useUserConnections(
  username: string,
  kind: UserConnectionKind,
  enabled = true,
) {
  return useInfiniteQuery({
    queryKey: ['connections', username, kind],
    queryFn: async ({ pageParam }) => {
      const response = await api.get<UserSummary[]>(
        `/users/${encodeURIComponent(username)}/${kind}`,
        { params: { page: pageParam, limit: CONNECTIONS_PAGE_SIZE } },
      );
      return response.data;
    },
    initialPageParam: 1,
    getNextPageParam: (lastPage, pages) =>
      lastPage.length === CONNECTIONS_PAGE_SIZE ? pages.length + 1 : undefined,
    enabled: Boolean(username) && enabled,
  });
}

export function useFollowRequests() {
  return useQuery<FollowRequest[]>({
    queryKey: ['follow-requests'],
    queryFn: async () => {
      const response = await api.get('/users/me/follow-requests');
      return response.data;
    },
    refetchInterval: 30_000,
  });
}

export function useAcceptFollowRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (userId: string) => {
      await api.post(`/users/me/follow-requests/${userId}/accept`);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['follow-requests'] });
      void qc.invalidateQueries({ queryKey: ['followers'] });
      void qc.invalidateQueries({ queryKey: ['user'] });
      void qc.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}

export function useRejectFollowRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (userId: string) => {
      await api.delete(`/users/me/follow-requests/${userId}`);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['follow-requests'] });
      void qc.invalidateQueries({ queryKey: ['user'] });
      void qc.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}

const BLOCKS_PAGE_SIZE = 50;

export function useBlockedUsers() {
  return useInfiniteQuery({
    queryKey: ['blocks'],
    queryFn: async ({ pageParam }) => {
      const response = await api.get<BlockedUser[]>('/users/me/blocks', {
        params: { page: pageParam, limit: BLOCKS_PAGE_SIZE },
      });
      return response.data;
    },
    initialPageParam: 1,
    getNextPageParam: (lastPage, pages) =>
      lastPage.length === BLOCKS_PAGE_SIZE ? pages.length + 1 : undefined,
  });
}

export function useBlockUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (username: string) => {
      const response = await api.post<{ blocked: true }>(
        `/users/${encodeURIComponent(username)}/block`,
      );
      return response.data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['blocks'] });
      void qc.invalidateQueries({ queryKey: ['user'] });
      void qc.invalidateQueries({ queryKey: ['user-search'] });
      void qc.invalidateQueries({ queryKey: ['activity'] });
      void qc.invalidateQueries({ queryKey: ['followers'] });
      void qc.invalidateQueries({ queryKey: ['following'] });
      void qc.invalidateQueries({ queryKey: ['follow-requests'] });
      void qc.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}

export function useUnblockUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (username: string) => {
      const response = await api.delete<{ blocked: false }>(
        `/users/${encodeURIComponent(username)}/block`,
      );
      return response.data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['blocks'] });
      void qc.invalidateQueries({ queryKey: ['user'] });
      void qc.invalidateQueries({ queryKey: ['user-search'] });
    },
  });
}
