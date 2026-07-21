import { groupUpNext, isDormant, lastWatchedLabel } from '@/lib/up-next';
import type { UpNextEpisode } from '@/types';

const NOW = new Date('2026-07-21T18:00:00Z').getTime();
const DAY = 24 * 60 * 60 * 1000;

function episode(id: string, daysAgo: number): UpNextEpisode {
  return {
    episode_id: id,
    media_id: `media-${id}`,
    tmdb_id: 1,
    title: id,
    poster_path: null,
    season_number: 1,
    episode_number: 1,
    episode_name: null,
    overview: null,
    runtime_minutes: null,
    air_date: '2026-01-01',
    still_path: null,
    is_planned: false,
    last_watched_at: new Date(NOW - daysAgo * DAY).toISOString(),
  };
}

describe('up next grouping', () => {
  it('keeps a show watched today out of the dormant group', () => {
    expect(isDormant(episode('today', 0), NOW)).toBe(false);
  });

  it('treats the threshold as exclusive so day 30 still counts as continuing', () => {
    expect(isDormant(episode('boundary', 30), NOW)).toBe(false);
    expect(isDormant(episode('past', 31), NOW)).toBe(true);
  });

  it('splits continuing from dormant and preserves the order it was given', () => {
    const groups = groupUpNext(
      [episode('a', 0), episode('b', 400), episode('c', 5), episode('d', 90)],
      NOW,
    );

    expect(groups.map((group) => group.key)).toEqual(['continuing', 'dormant']);
    expect(groups[0].items.map((item) => item.episode_id)).toEqual(['a', 'c']);
    expect(groups[1].items.map((item) => item.episode_id)).toEqual(['b', 'd']);
  });

  it('drops an empty group so the screen never heads a list with nothing in it', () => {
    const groups = groupUpNext([episode('a', 1), episode('b', 2)], NOW);

    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('continuing');
  });

  it('returns no groups at all when there is nothing to show', () => {
    expect(groupUpNext([], NOW)).toEqual([]);
  });

  it('describes elapsed time in units that stay readable as it grows', () => {
    expect(lastWatchedLabel(episode('a', 45).last_watched_at, NOW)).toBe('45 days ago');
    expect(lastWatchedLabel(episode('b', 90).last_watched_at, NOW)).toBe('3 months ago');
    expect(lastWatchedLabel(episode('c', 400).last_watched_at, NOW)).toBe('a year ago');
    expect(lastWatchedLabel(episode('d', 1100).last_watched_at, NOW)).toBe('3 years ago');
  });
});
