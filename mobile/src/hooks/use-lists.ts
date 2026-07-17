import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiRequest } from '@/lib/api';
import { withQuery } from '@/lib/http';
import type { ListInput } from '@/lib/lists';
import type {
  CustomList,
  CustomListDetail,
  CustomListSummary,
} from '@/types';

export const listKeys = {
  all: ['lists'] as const,
  mine: ['lists', 'mine'] as const,
  detail: (id: string) => ['lists', 'detail', id] as const,
};

export function useMyLists(enabled = true) {
  return useQuery({
    queryKey: listKeys.mine,
    queryFn: () =>
      apiRequest<CustomListSummary[]>(
        withQuery('/lists/me', { page: 1, limit: 50 }),
      ),
    enabled,
  });
}

export function useList(id: string | undefined) {
  return useQuery({
    queryKey: listKeys.detail(id ?? ''),
    queryFn: () =>
      apiRequest<CustomListDetail>(`/lists/${encodeURIComponent(id ?? '')}`),
    enabled: Boolean(id),
  });
}

export function useCreateList() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ListInput) =>
      apiRequest<CustomList>('/lists', { method: 'POST', body: input }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: listKeys.mine }),
  });
}

export function useUpdateList() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: ListInput & { id: string }) =>
      apiRequest<CustomList>(`/lists/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: input,
      }),
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
    mutationFn: (id: string) =>
      apiRequest(`/lists/${encodeURIComponent(id)}`, { method: 'DELETE' }),
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
      apiRequest(`/lists/${encodeURIComponent(listId)}/items`, {
        method: 'POST',
        body: { media_id: mediaId },
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
      apiRequest(
        `/lists/${encodeURIComponent(listId)}/items/${encodeURIComponent(mediaId)}`,
        { method: 'DELETE' },
      ),
    onSuccess: (_data, variables) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: listKeys.mine }),
        queryClient.invalidateQueries({ queryKey: listKeys.detail(variables.listId) }),
      ]),
  });
}
