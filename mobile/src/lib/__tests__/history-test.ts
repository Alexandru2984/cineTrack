import {
  historyEpisodeLabel,
  localDateInput,
  previousLocalDate,
  uniqueHistory,
  watchedAtFromDateInput,
} from '@/lib/history';
import type { HistoryItem } from '@/types';

const item: HistoryItem = {
  id: 'history-1',
  media_id: 'media-1',
  tmdb_id: 1,
  media_title: 'Show',
  media_type: 'tv',
  poster_path: null,
  episode_id: 'episode-1',
  episode_name: 'Again',
  season_number: 3,
  episode_number: 7,
  watched_at: '2026-07-12T20:00:00Z',
};

describe('mobile history helpers', () => {
  it('converts real non-future calendar dates to a stable UTC timestamp', () => {
    const now = new Date('2026-07-17T10:00:00Z');
    expect(watchedAtFromDateInput('2026-02-28', now)).toBe('2026-02-28T12:00:00.000Z');
    expect(watchedAtFromDateInput('2026-02-30', now)).toBeNull();
    expect(watchedAtFromDateInput('2026-07-18', now)).toBeNull();
    expect(watchedAtFromDateInput('17-07-2026', now)).toBeNull();
  });

  it('creates local today and yesterday inputs without UTC date drift', () => {
    const date = new Date(2026, 6, 17, 1);
    expect(localDateInput(date)).toBe('2026-07-17');
    expect(previousLocalDate(date)).toBe('2026-07-16');
  });

  it('formats episode context and deduplicates overlapping pages', () => {
    expect(historyEpisodeLabel(item)).toBe('S03E07 · Again');
    expect(uniqueHistory([[item], [item]])).toEqual([item]);
  });
});
