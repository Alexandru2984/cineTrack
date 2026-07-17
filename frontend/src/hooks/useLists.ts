import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import api from '@/lib/api';
import type { CustomList, CustomListDetail, ListResponse } from '@/types';

export const listKeys = {
  all: ['lists'] as const,
  mine: ['lists', 'mine'] as const,
  detail: (id: string) => ['lists', 'detail', id] as const,
};

export interface ListInput {
  name: string;
  description?: string;
  is_public: boolean;
}

export function useMyLists(enabled = true) {
  return useQuery<ListResponse[]>({
    queryKey: listKeys.mine,
    queryFn: async () => {
      const response = await api.get<ListResponse[]>('/lists/me', {
        params: { page: 1, limit: 50 },
      });
      return response.data;
    },
    enabled,
  });
}

export function useList(id: string | undefined) {
  return useQuery<CustomListDetail>({
    queryKey: listKeys.detail(id ?? ''),
    queryFn: async () => {
      const response = await api.get<CustomListDetail>(
        `/lists/${encodeURIComponent(id ?? '')}`,
      );
      return response.data;
    },
    enabled: Boolean(id),
  });
}

export function useCreateList() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ListInput) => {
      const response = await api.post<CustomList>('/lists', input);
      return response.data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: listKeys.mine }),
  });
}

export function useUpdateList() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...input }: ListInput & { id: string }) => {
      const response = await api.patch<CustomList>(
        `/lists/${encodeURIComponent(id)}`,
        input,
      );
      return response.data;
    },
    onSuccess: (_data, variables) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: listKeys.mine }),
        queryClient.invalidateQueries({ queryKey: listKeys.detail(variables.id) }),
      ]),
  });
}

export function useDeleteList() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/lists/${encodeURIComponent(id)}`),
    onSuccess: (_data, id) => {
      queryClient.removeQueries({ queryKey: listKeys.detail(id) });
      return queryClient.invalidateQueries({ queryKey: listKeys.mine });
    },
  });
}

export function useAddListItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ listId, mediaId }: { listId: string; mediaId: string }) =>
      api.post(`/lists/${encodeURIComponent(listId)}/items`, {
        media_id: mediaId,
      }),
    onSuccess: (_data, variables) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: listKeys.mine }),
        queryClient.invalidateQueries({ queryKey: listKeys.detail(variables.listId) }),
      ]),
  });
}

export function useRemoveListItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ listId, mediaId }: { listId: string; mediaId: string }) =>
      api.delete(
        `/lists/${encodeURIComponent(listId)}/items/${encodeURIComponent(mediaId)}`,
      ),
    onSuccess: (_data, variables) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: listKeys.mine }),
        queryClient.invalidateQueries({ queryKey: listKeys.detail(variables.listId) }),
      ]),
  });
}
