import { useQuery } from '@tanstack/react-query';

import api from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import type { BadgeShelf } from '@/types';

export const badgeKeys = {
  shelf: ['badges', 'shelf'] as const,
};

export function useBadges() {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated());
  return useQuery<BadgeShelf>({
    queryKey: badgeKeys.shelf,
    queryFn: async () => {
      const response = await api.get<BadgeShelf>('/badges');
      return response.data;
    },
    enabled: isAuthenticated,
    // Badges move when history moves, and history moves on the pages that
    // invalidate their own queries. A slow refetch keeps the shelf honest
    // without polling for something that changes a few times a week.
    staleTime: 5 * 60 * 1000,
  });
}
