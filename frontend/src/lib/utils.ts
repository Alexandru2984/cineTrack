import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// When VITE_USE_R2_IMAGES is enabled, images are served through the backend's
// write-through R2 cache (/api/img) instead of TMDB directly. Off by default.
const USE_R2_IMAGES = import.meta.env.VITE_USE_R2_IMAGES === 'true';
const API_URL = import.meta.env.VITE_API_URL || '';

function tmdbImage(path: string, size: string): string {
  if (USE_R2_IMAGES) {
    return `${API_URL}/api/img/${size}${path}`;
  }
  return `https://image.tmdb.org/t/p/${size}${path}`;
}

export function getPosterUrl(path: string | null | undefined, size = 'w342'): string {
  if (!path) return '/placeholder-poster.svg';
  return tmdbImage(path, size);
}

export function getBackdropUrl(path: string | null | undefined, size = 'w1280'): string {
  if (!path) return '';
  return tmdbImage(path, size);
}

export function getLogoUrl(path: string | null | undefined, size = 'w92'): string {
  if (!path) return '';
  return tmdbImage(path, size);
}

export function formatDate(date: string | null | undefined): string {
  if (!date) return 'N/A';
  return new Date(date).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatDateTime(date: string | null | undefined): string {
  if (!date) return 'N/A';
  return new Date(date).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatRuntime(minutes: number | null | undefined): string {
  if (!minutes) return 'N/A';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export const STATUS_LABELS: Record<string, string> = {
  watching: 'Watching',
  completed: 'Completed',
  plan_to_watch: 'Plan to Watch',
  dropped: 'Dropped',
  on_hold: 'On Hold',
};

export const STATUS_COLORS: Record<string, string> = {
  watching: 'bg-blue-500',
  completed: 'bg-green-500',
  plan_to_watch: 'bg-yellow-500',
  dropped: 'bg-red-500',
  on_hold: 'bg-gray-500',
};
