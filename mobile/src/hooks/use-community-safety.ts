import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';

import { apiRequest } from '@/lib/api';
import type { ReportReason, ReportTargetType } from '@/lib/community-safety';
import { withQuery } from '@/lib/http';
import { socialKeys } from '@/hooks/use-social';
import type { BlockedUser, SafetyReport } from '@/types';

const BLOCKS_PAGE_SIZE = 50;

export const safetyKeys = {
  all: ['community-safety'] as const,
  blocks: ['community-safety', 'blocks'] as const,
  reports: ['community-safety', 'reports'] as const,
};

export function useBlockedUsers() {
  return useInfiniteQuery({
    queryKey: safetyKeys.blocks,
    queryFn: ({ pageParam }) =>
      apiRequest<BlockedUser[]>(
        withQuery('/users/me/blocks', {
          page: pageParam,
          limit: BLOCKS_PAGE_SIZE,
        }),
      ),
    initialPageParam: 1,
    getNextPageParam: (lastPage, pages) =>
      lastPage.length === BLOCKS_PAGE_SIZE ? pages.length + 1 : undefined,
  });
}

function invalidateSafetyContext(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: safetyKeys.all });
  void queryClient.invalidateQueries({ queryKey: socialKeys.all });
  void queryClient.invalidateQueries({ queryKey: ['notifications'] });
  void queryClient.invalidateQueries({ queryKey: ['lists'] });
}

export function useBlockUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (username: string) =>
      apiRequest<{ blocked: true }>(`/users/${encodeURIComponent(username)}/block`, {
        method: 'POST',
      }),
    onSuccess: () => invalidateSafetyContext(queryClient),
  });
}

export function useUnblockUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (username: string) =>
      apiRequest<{ blocked: false }>(`/users/${encodeURIComponent(username)}/block`, {
        method: 'DELETE',
      }),
    onSuccess: () => invalidateSafetyContext(queryClient),
  });
}

export function useReportContent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      target_type: ReportTargetType;
      target_id: string;
      reason: ReportReason;
      details?: string;
    }) => apiRequest<SafetyReport>('/reports', { method: 'POST', body: input }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: safetyKeys.reports });
    },
  });
}
