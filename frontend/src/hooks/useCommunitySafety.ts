import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import api from '@/lib/api';
import type { ReportReason, ReportTargetType } from '@/lib/community-safety';
import type {
  ModerationQueue,
  ModerationReport,
  ModerationReportStatus,
  SafetyReport,
} from '@/types';

export type ModerationQueueFilter =
  | 'active'
  | 'all'
  | ModerationReportStatus;

export const moderationKeys = {
  all: ['moderation'] as const,
  status: ['moderation', 'status'] as const,
  queue: (status: ModerationQueueFilter, page: number) =>
    ['moderation', 'reports', status, page] as const,
};

export function useReportContent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      target_type: ReportTargetType;
      target_id: string;
      reason: ReportReason;
      details?: string;
    }) => {
      const response = await api.post<SafetyReport>('/reports', input);
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['reports', 'mine'] });
    },
  });
}

export function useModeratorStatus() {
  return useQuery({
    queryKey: moderationKeys.status,
    queryFn: async () => {
      const response = await api.get<{ is_moderator: boolean }>('/moderation/me');
      return response.data;
    },
    staleTime: 60_000,
  });
}

export function useModerationReports(
  status: ModerationQueueFilter,
  page: number,
) {
  return useQuery({
    queryKey: moderationKeys.queue(status, page),
    queryFn: async () => {
      const response = await api.get<ModerationQueue>('/moderation/reports', {
        params: { status, page, limit: 25 },
      });
      return response.data;
    },
  });
}

export function useUpdateModerationReport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      status,
      note,
    }: {
      id: string;
      status: ModerationReportStatus;
      note: string;
    }) => {
      const response = await api.patch<ModerationReport>(
        `/moderation/reports/${encodeURIComponent(id)}`,
        { status, note },
      );
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: moderationKeys.all });
    },
  });
}
