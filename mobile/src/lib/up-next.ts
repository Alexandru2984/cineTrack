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
  /** i18n key resolved by the caller, so this stays a pure, locale-agnostic helper. */
  titleKey: 'upNext.continueWatching' | 'upNext.pickBackUp';
  items: UpNextEpisode[];
};

/** Empty groups are dropped so the screen never renders a heading over nothing,
 *  which also lets the caller skip headings entirely when only one survives. */
export function groupUpNext(items: UpNextEpisode[], now = Date.now()): UpNextGroup[] {
  const groups: UpNextGroup[] = [
    {
      key: 'continuing',
      titleKey: 'upNext.continueWatching',
      items: items.filter((item) => !isDormant(item, now)),
    },
    {
      key: 'dormant',
      titleKey: 'upNext.pickBackUp',
      items: items.filter((item) => isDormant(item, now)),
    },
  ];
  return groups.filter((group) => group.items.length > 0);
}

/** A locale-agnostic description of how long ago something happened; the caller
 *  maps it to a localized string (see `upNext.daysAgo` and friends). */
export type ElapsedSince =
  | { unit: 'days'; count: number }
  | { unit: 'months'; count: number }
  | { unit: 'aYear' }
  | { unit: 'years'; count: number };

export function elapsedSince(value: string, now = Date.now()): ElapsedSince {
  const days = Math.floor((now - new Date(value).getTime()) / DAY_MS);
  if (days < 60) return { unit: 'days', count: days };
  if (days < 365) return { unit: 'months', count: Math.round(days / 30) };
  const years = Math.floor(days / 365);
  return years === 1 ? { unit: 'aYear' } : { unit: 'years', count: years };
}
