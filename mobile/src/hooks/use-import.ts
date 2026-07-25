import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  getTVTimeImportJob,
  listTVTimeImportJobs,
  startTVTimeImport,
  type SelectedImportFiles,
} from '@/lib/import';

export const importKeys = {
  all: ['imports'] as const,
  jobs: ['imports', 'jobs'] as const,
  job: (jobId: string) => ['imports', 'job', jobId] as const,
};

export function useImportJobs(enabled = true) {
  return useQuery({
    queryKey: importKeys.jobs,
    queryFn: listTVTimeImportJobs,
    enabled,
  });
}

export function useImportJob(jobId: string | null, enabled = true) {
  return useQuery({
    queryKey: jobId ? importKeys.job(jobId) : ['imports', 'job', 'none'],
    queryFn: () => getTVTimeImportJob(jobId!),
    enabled: enabled && Boolean(jobId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'pending' || status === 'running' ? 2_000 : false;
    },
  });
}

export function useStartImport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (files: SelectedImportFiles) => startTVTimeImport(files),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: importKeys.all }),
  });
}
