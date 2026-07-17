import {
  buildHeatmapWeeks,
  formatActivityMonth,
  heatmapLevel,
} from '@/lib/statistics';

describe('mobile statistics', () => {
  it('maps activity counts to the same five levels as the web heatmap', () => {
    expect([0, 1, 3, 5, 8].map(heatmapLevel)).toEqual([0, 1, 2, 3, 4]);
    expect(heatmapLevel(-3)).toBe(0);
    expect(heatmapLevel(100)).toBe(4);
  });

  it('builds complete UTC-aligned weeks for a leap year', () => {
    const weeks = buildHeatmapWeeks(2024, [
      { date: '2024-01-01', count: 3 },
      { date: '2024-02-29', count: 8 },
    ]);
    const cells = weeks.flat();
    expect(weeks).toHaveLength(53);
    expect(cells.filter((cell) => cell.date !== null)).toHaveLength(366);
    expect(cells.find((cell) => cell.date === '2024-01-01')).toMatchObject({
      count: 3,
      level: 2,
    });
    expect(cells.find((cell) => cell.date === '2024-02-29')).toMatchObject({
      count: 8,
      level: 4,
    });
  });

  it('formats valid months and leaves malformed values visible', () => {
    expect(formatActivityMonth('2026-07')).toMatch(/2026/);
    expect(formatActivityMonth('invalid')).toBe('invalid');
  });
});
