import { useQuery } from '@tanstack/react-query';

import { apiRequest } from '@/lib/api';
import type { UserStats } from '@/types';

export function useMyStats() {
  return useQuery({
    queryKey: ['stats', 'me'],
    queryFn: () => apiRequest<UserStats>('/stats/me'),
  });
}
