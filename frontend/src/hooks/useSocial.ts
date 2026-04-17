import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/api';
import type { PublicUserProfile, ActivityItem, UserSummary } from '@/types';

export function useUserProfile(username: string) {
  return useQuery<PublicUserProfile>({
    queryKey: ['user', username],
    queryFn: async () => {
      const res = await api.get(`/users/${username}`);
      return res.data;
    },
    enabled: !!username,
  });
}

export function useUserActivity(username: string) {
  return useQuery<ActivityItem[]>({
    queryKey: ['user', username, 'activity'],
    queryFn: async () => {
      const res = await api.get(`/users/${username}/activity`);
      return res.data;
    },
    enabled: !!username,
  });
}

export function useFollow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (username: string) => {
      await api.post(`/users/${username}/follow`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['user'] }),
  });
}

export function useUnfollow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (username: string) => {
      await api.delete(`/users/${username}/follow`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['user'] }),
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
