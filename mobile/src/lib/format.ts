import type { TrackingStatus } from '@/types';

export const trackingStatusLabels: Record<TrackingStatus, string> = {
  watching: 'Watching',
  completed: 'Completed',
  plan_to_watch: 'Plan to watch',
  on_hold: 'On hold',
  dropped: 'Dropped',
};

export function episodeCode(season: number, episode: number) {
  return `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
}

export function formatDate(value: string, weekday = false) {
  return new Intl.DateTimeFormat(undefined, {
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
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}
