import {
  isValidPeopleSearch,
  nextActivityCursor,
  relationshipLabel,
  SOCIAL_PAGE_LIMIT,
  uniqueActivities,
} from '@/lib/social';
import type { ActivityItem } from '@/types';

function activity(id: string): ActivityItem {
  return {
    id,
    user_id: 'user-1',
    username: 'viewer',
    avatar_url: null,
    action: 'watched',
    tmdb_id: 1,
    media_title: 'Film',
    media_type: 'movie',
    poster_path: null,
    episode_id: null,
    episode_name: null,
    season_number: null,
    episode_number: null,
    timestamp: `2026-01-01T00:00:${id.padStart(2, '0')}Z`,
  };
}

describe('mobile social helpers', () => {
  it('validates literal username searches before calling the API', () => {
    expect(isValidPeopleSearch('film_buff')).toBe(true);
    expect(isValidPeopleSearch('a')).toBe(false);
    expect(isValidPeopleSearch('../admin')).toBe(false);
  });

  it('uses the final activity as a complete-page cursor', () => {
    const items = Array.from({ length: SOCIAL_PAGE_LIMIT }, (_, index) => activity(String(index)));
    expect(nextActivityCursor(items)).toEqual({
      before: items.at(-1)?.timestamp,
      before_id: items.at(-1)?.id,
    });
    expect(nextActivityCursor(items.slice(0, 3))).toBeUndefined();
  });

  it('deduplicates overlapping cursor pages', () => {
    expect(uniqueActivities([[activity('1'), activity('2')], [activity('2')]]))
      .toHaveLength(2);
  });

  it('describes every relationship action', () => {
    expect(relationshipLabel('accepted', true)).toBe('Unfollow');
    expect(relationshipLabel('pending', false)).toBe('Cancel request');
    expect(relationshipLabel(null, false)).toBe('Request');
  });
});
