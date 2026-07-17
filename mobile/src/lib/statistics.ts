import type { HeatmapDay } from '@/types';

export interface HeatmapCell {
  date: string | null;
  count: number;
  level: 0 | 1 | 2 | 3 | 4;
}

function utcDateKey(date: Date) {
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${date.getUTCFullYear()}-${month}-${day}`;
}

export function heatmapLevel(count: number): HeatmapCell['level'] {
  if (count >= 8) return 4;
  if (count >= 5) return 3;
  if (count >= 3) return 2;
  if (count >= 1) return 1;
  return 0;
}

export function buildHeatmapWeeks(
  year: number,
  activity: readonly HeatmapDay[],
): HeatmapCell[][] {
  const countByDate = new Map(activity.map((day) => [day.date, Math.max(0, day.count)]));
  const firstDay = new Date(Date.UTC(year, 0, 1));
  const lastDay = new Date(Date.UTC(year, 11, 31));
  const cells: HeatmapCell[] = Array.from({ length: firstDay.getUTCDay() }, () => ({
    date: null,
    count: 0,
    level: 0,
  }));

  for (
    let cursor = firstDay;
    cursor <= lastDay;
    cursor = new Date(cursor.getTime() + 86_400_000)
  ) {
    const date = utcDateKey(cursor);
    const count = countByDate.get(date) ?? 0;
    cells.push({ date, count, level: heatmapLevel(count) });
  }

  while (cells.length % 7 !== 0) {
    cells.push({ date: null, count: 0, level: 0 });
  }

  return Array.from({ length: cells.length / 7 }, (_, index) =>
    cells.slice(index * 7, index * 7 + 7),
  );
}

export function formatActivityMonth(value: string) {
  const [year, month] = value.split('-').map(Number);
  if (!year || !month || month < 1 || month > 12) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, 1)));
}
