import type { TrackingStatus } from '@/types';

export const trackingStatusLabels: Record<TrackingStatus, string> = {
  watching: 'Watching',
  completed: 'Completed',
  plan_to_watch: 'Plan to watch',
  on_hold: 'On hold',
  dropped: 'Dropped',
};

// The active UI locale tag, kept in sync by the locale store (see
// `store/locale.ts`). Keeping it here lets these stay plain functions the whole
// codebase can import directly, while still following the user's chosen
// language instead of the device default.
let activeLocaleTag = 'en-US';

export function setFormatLocaleTag(tag: string) {
  activeLocaleTag = tag;
}

export function getFormatLocaleTag() {
  return activeLocaleTag;
}

export function episodeCode(season: number, episode: number) {
  return `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
}

export function formatDate(value: string, weekday = false) {
  return new Intl.DateTimeFormat(activeLocaleTag, {
    ...(weekday ? { weekday: 'short' as const } : {}),
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(`${value}T12:00:00`));
}

export function formatRuntime(minutes: number | null | undefined) {
  if (!minutes) return null;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return hours > 0 ? `${hours}h ${remainder}m` : `${remainder}m`;
}

export function formatDateTime(value: string) {
  return new Intl.DateTimeFormat(activeLocaleTag, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

export function formatNumber(value: number) {
  return new Intl.NumberFormat(activeLocaleTag).format(value);
}
