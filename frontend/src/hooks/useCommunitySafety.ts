import { useMutation, useQueryClient } from '@tanstack/react-query';

import api from '@/lib/api';
import type { ReportReason, ReportTargetType } from '@/lib/community-safety';
import type { SafetyReport } from '@/types';

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
