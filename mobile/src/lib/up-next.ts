import type { UpNextEpisode } from '@/types';

/** A show untouched for this long is something you dropped mid-run, not
 *  something you are watching. Both are worth surfacing, but not in one list. */
export const RESUME_AFTER_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export function isDormant(item: UpNextEpisode, now = Date.now()) {
  return now - new Date(item.last_watched_at).getTime() > RESUME_AFTER_DAYS * DAY_MS;
}

export type UpNextGroup = {
  key: 'continuing' | 'dormant';
  title: string;
  items: UpNextEpisode[];
};

/** Empty groups are dropped so the screen never renders a heading over nothing,
 *  which also lets the caller skip headings entirely when only one survives. */
export function groupUpNext(items: UpNextEpisode[], now = Date.now()): UpNextGroup[] {
  const groups: UpNextGroup[] = [
    {
      key: 'continuing',
      title: 'Continue watching',
      items: items.filter((item) => !isDormant(item, now)),
    },
    {
      key: 'dormant',
      title: 'Pick back up',
      items: items.filter((item) => isDormant(item, now)),
    },
  ];
  return groups.filter((group) => group.items.length > 0);
}

export function lastWatchedLabel(value: string, now = Date.now()) {
  const days = Math.floor((now - new Date(value).getTime()) / DAY_MS);
  if (days < 60) return `${days} days ago`;
  if (days < 365) return `${Math.round(days / 30)} months ago`;
  const years = Math.floor(days / 365);
  return years === 1 ? 'a year ago' : `${years} years ago`;
}
