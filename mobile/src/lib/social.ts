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

type Translate = (key: string, params?: Record<string, string | number>) => string;

export function relationshipLabel(t: Translate, status: FollowStatus, isPublic: boolean) {
  if (status === 'accepted') return t('social.unfollow');
  if (status === 'pending') return t('social.cancelRequest');
  return isPublic ? t('social.follow') : t('social.request');
}
