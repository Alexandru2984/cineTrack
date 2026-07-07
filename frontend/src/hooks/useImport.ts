import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/api';
import type { ImportJob } from '@/types';

export interface StartImportFiles {
  shows?: File | null;
  movies?: File | null;
  rewatches?: File | null;
}

export function useImportJobs() {
  return useQuery<ImportJob[]>({
    queryKey: ['import', 'jobs'],
    queryFn: async () => {
      const res = await api.get('/import/jobs');
      return res.data;
    },
  });
}

export function useStartImport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (files: StartImportFiles) => {
      const form = new FormData();
      if (files.shows) form.append('shows', files.shows);
      if (files.movies) form.append('movies', files.movies);
      if (files.rewatches) form.append('rewatches', files.rewatches);
      const res = await api.post<{ job_id: string }>('/import/tvtime', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['import', 'jobs'] });
    },
  });
}

/** Poll a single import job while it is pending/running. */
export function useImportJob(jobId: string | null) {
  return useQuery<ImportJob>({
    queryKey: ['import', 'job', jobId],
    queryFn: async () => {
      const res = await api.get(`/import/jobs/${jobId}`);
      return res.data;
    },
    enabled: !!jobId,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'pending' || status === 'running' ? 2000 : false;
    },
  });
}
