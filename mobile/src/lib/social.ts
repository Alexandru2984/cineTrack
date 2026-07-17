import type { ActivityItem, FollowStatus } from '@/types';

export const SOCIAL_PAGE_LIMIT = 20;

export interface ActivityCursor {
  before: string;
  before_id: string;
}

export function isValidPeopleSearch(query: string) {
  return /^[A-Za-z0-9_-]{2,50}$/.test(query.trim());
}

export function nextActivityCursor(items: ActivityItem[]): ActivityCursor | undefined {
  if (items.length < SOCIAL_PAGE_LIMIT) return undefined;
  const last = items.at(-1);
  return last ? { before: last.timestamp, before_id: last.id } : undefined;
}

export function uniqueActivities(pages: ActivityItem[][]) {
  return Array.from(new Map(pages.flat().map((item) => [item.id, item])).values());
}

export function relationshipLabel(status: FollowStatus, isPublic: boolean) {
  if (status === 'accepted') return 'Unfollow';
  if (status === 'pending') return 'Cancel request';
  return isPublic ? 'Follow' : 'Request';
}
