import { useQuery } from '@tanstack/react-query';

import { apiRequest } from '@/lib/api';
import { hasLocalSession, useAuthStore } from '@/store/auth';
import type { BadgeShelf } from '@/types';

export const badgeKeys = {
  shelf: ['badges', 'shelf'] as const,
};

export function useBadges() {
  const status = useAuthStore((state) => state.status);
  return useQuery<BadgeShelf>({
    queryKey: badgeKeys.shelf,
    queryFn: () => apiRequest<BadgeShelf>('/badges'),
    enabled: hasLocalSession(status),
    // Badges move when history moves, which happens on screens that invalidate
    // their own queries. Polling would ask repeatedly for an answer that
    // changes a few times a week.
    staleTime: 5 * 60 * 1000,
  });
}
