import type { HistoryItem } from '@/types';

export const HISTORY_PAGE_LIMIT = 50;

export function localDateInput(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function previousLocalDate(date = new Date()) {
  const previous = new Date(date);
  previous.setDate(previous.getDate() - 1);
  return localDateInput(previous);
}

export function watchedAtFromDateInput(value: string, now = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day, 12));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day ||
    value > localDateInput(now)
  ) {
    return null;
  }
  return parsed.toISOString();
}

export function historyEpisodeLabel(item: HistoryItem) {
  if (item.season_number === null || item.episode_number === null) {
    return item.episode_name;
  }
  const code = `S${String(item.season_number).padStart(2, '0')}E${String(item.episode_number).padStart(2, '0')}`;
  return item.episode_name ? `${code} · ${item.episode_name}` : code;
}

export function uniqueHistory(pages: HistoryItem[][]) {
  return Array.from(new Map(pages.flat().map((item) => [item.id, item])).values());
}
