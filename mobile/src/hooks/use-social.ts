import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiRequest } from '@/lib/api';
import { withQuery } from '@/lib/http';
import {
  isValidPeopleSearch,
  nextActivityCursor,
  SOCIAL_PAGE_LIMIT,
  type ActivityCursor,
} from '@/lib/social';
import type {
  ActivityItem,
  FollowRequest,
  PublicUserProfile,
  UserSearchResponse,
  UserSummary,
} from '@/types';

export const socialKeys = {
  all: ['social'] as const,
  feed: ['social', 'feed'] as const,
  search: (query: string) => ['social', 'search', query] as const,
  profile: (username: string) => ['social', 'profile', username] as const,
  activity: (username: string) => ['social', 'activity', username] as const,
  requests: ['social', 'requests'] as const,
  connections: (kind: 'followers' | 'following') => ['social', kind] as const,
};

export function useSocialFeed(enabled = true) {
  return useInfiniteQuery({
    queryKey: socialKeys.feed,
    queryFn: ({ pageParam }) =>
      apiRequest<ActivityItem[]>(
        withQuery('/users/me/feed', {
          limit: SOCIAL_PAGE_LIMIT,
          ...(pageParam as ActivityCursor | null),
        }),
      ),
    initialPageParam: null as ActivityCursor | null,
    getNextPageParam: nextActivityCursor,
    enabled,
  });
}

export function usePeopleSearch(query: string, enabled = true) {
  const normalized = query.trim();
  return useInfiniteQuery({
    queryKey: socialKeys.search(normalized),
    queryFn: ({ pageParam }) =>
      apiRequest<UserSearchResponse>(
        withQuery('/users/search', {
          q: normalized,
          page: pageParam,
          limit: SOCIAL_PAGE_LIMIT,
        }),
      ),
    initialPageParam: 1,
    getNextPageParam: (lastPage) => lastPage.has_more ? lastPage.page + 1 : undefined,
    enabled: enabled && isValidPeopleSearch(normalized),
  });
}

export function usePublicUserProfile(username: string, enabled = true) {
  return useQuery({
    queryKey: socialKeys.profile(username),
    queryFn: () =>
      apiRequest<PublicUserProfile>(`/users/${encodeURIComponent(username)}`),
    enabled: enabled && username.length > 0,
  });
}

export function usePublicUserActivity(username: string, enabled = true) {
  return useInfiniteQuery({
    queryKey: socialKeys.activity(username),
    queryFn: ({ pageParam }) =>
      apiRequest<ActivityItem[]>(
        withQuery(`/users/${encodeURIComponent(username)}/activity`, {
          page: pageParam,
          limit: SOCIAL_PAGE_LIMIT,
        }),
      ),
    initialPageParam: 1,
    getNextPageParam: (lastPage, pages) =>
      lastPage.length === SOCIAL_PAGE_LIMIT ? pages.length + 1 : undefined,
    enabled: enabled && username.length > 0,
  });
}

export function useFollowRequests(enabled = true) {
  return useInfiniteQuery({
    queryKey: socialKeys.requests,
    queryFn: ({ pageParam }) =>
      apiRequest<FollowRequest[]>(
        withQuery('/users/me/follow-requests', {
          page: pageParam,
          limit: SOCIAL_PAGE_LIMIT,
        }),
      ),
    initialPageParam: 1,
    getNextPageParam: (lastPage, pages) =>
      lastPage.length === SOCIAL_PAGE_LIMIT ? pages.length + 1 : undefined,
    enabled,
  });
}

export function useConnections(kind: 'followers' | 'following', enabled = true) {
  return useInfiniteQuery({
    queryKey: socialKeys.connections(kind),
    queryFn: ({ pageParam }) =>
      apiRequest<UserSummary[]>(
        withQuery(`/users/me/${kind}`, {
          page: pageParam,
          limit: SOCIAL_PAGE_LIMIT,
        }),
      ),
    initialPageParam: 1,
    getNextPageParam: (lastPage, pages) =>
      lastPage.length === SOCIAL_PAGE_LIMIT ? pages.length + 1 : undefined,
    enabled,
  });
}

function useInvalidateSocial() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: socialKeys.all });
    void queryClient.invalidateQueries({ queryKey: ['notifications'] });
  };
}

export function useFollowUser() {
  const invalidate = useInvalidateSocial();
  return useMutation({
    mutationFn: (username: string) =>
      apiRequest<{ status: 'pending' | 'accepted' }>(
        `/users/${encodeURIComponent(username)}/follow`,
        { method: 'POST' },
      ),
    onSuccess: invalidate,
  });
}

export function useUnfollowUser() {
  const invalidate = useInvalidateSocial();
  return useMutation({
    mutationFn: (username: string) =>
      apiRequest(`/users/${encodeURIComponent(username)}/follow`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });
}

export function useAcceptFollowRequest() {
  const invalidate = useInvalidateSocial();
  return useMutation({
    mutationFn: (userId: string) =>
      apiRequest(`/users/me/follow-requests/${encodeURIComponent(userId)}/accept`, {
        method: 'POST',
      }),
    onSuccess: invalidate,
  });
}

export function useRejectFollowRequest() {
  const invalidate = useInvalidateSocial();
  return useMutation({
    mutationFn: (userId: string) =>
      apiRequest(`/users/me/follow-requests/${encodeURIComponent(userId)}`, {
        method: 'DELETE',
      }),
    onSuccess: invalidate,
  });
}
