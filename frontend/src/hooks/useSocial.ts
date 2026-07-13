import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/api';
import type {
  PublicUserProfile,
  ActivityItem,
  UserSummary,
  FollowRequest,
  UserSearchResponse,
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

export function useFollowers() {
  return useQuery<UserSummary[]>({
    queryKey: ['followers'],
    queryFn: async () => {
      const res = await api.get('/users/me/followers');
      return res.data;
    },
  });
}

export function useFollowing() {
  return useQuery<UserSummary[]>({
    queryKey: ['following'],
    queryFn: async () => {
      const res = await api.get('/users/me/following');
      return res.data;
    },
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
    },
  });
}
