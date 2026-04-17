import { describe, it, expect } from 'vitest';
import { cn, getPosterUrl, getBackdropUrl, formatDate, formatRuntime, STATUS_LABELS, STATUS_COLORS } from '@/lib/utils';

describe('cn (class merging)', () => {
  it('merges simple classes', () => {
    expect(cn('foo', 'bar')).toBe('foo bar');
  });

  it('handles conditional classes', () => {
    expect(cn('base', false && 'hidden', 'extra')).toBe('base extra');
  });

  it('merges tailwind conflicting classes', () => {
    const result = cn('p-4', 'p-2');
    expect(result).toBe('p-2');
  });

  it('handles empty input', () => {
    expect(cn()).toBe('');
  });
});

describe('getPosterUrl', () => {
  it('returns TMDB URL for valid path', () => {
    expect(getPosterUrl('/abc.jpg')).toBe('https://image.tmdb.org/t/p/w342/abc.jpg');
  });

  it('returns placeholder for null', () => {
    expect(getPosterUrl(null)).toBe('/placeholder-poster.svg');
  });

  it('returns placeholder for undefined', () => {
    expect(getPosterUrl(undefined)).toBe('/placeholder-poster.svg');
  });

  it('returns placeholder for empty string', () => {
    expect(getPosterUrl('')).toBe('/placeholder-poster.svg');
  });

  it('respects custom size', () => {
    expect(getPosterUrl('/img.jpg', 'w500')).toBe('https://image.tmdb.org/t/p/w500/img.jpg');
  });
});

describe('getBackdropUrl', () => {
  it('returns TMDB URL for valid path', () => {
    expect(getBackdropUrl('/bg.jpg')).toBe('https://image.tmdb.org/t/p/w1280/bg.jpg');
  });

  it('returns empty string for null', () => {
    expect(getBackdropUrl(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(getBackdropUrl(undefined)).toBe('');
  });

  it('respects custom size', () => {
    expect(getBackdropUrl('/bg.jpg', 'original')).toBe('https://image.tmdb.org/t/p/original/bg.jpg');
  });
});

describe('formatDate', () => {
  it('formats a valid date', () => {
    const result = formatDate('2024-06-15');
    expect(result).toContain('2024');
    expect(result).toContain('Jun');
    expect(result).toContain('15');
  });

  it('returns N/A for null', () => {
    expect(formatDate(null)).toBe('N/A');
  });

  it('returns N/A for undefined', () => {
    expect(formatDate(undefined)).toBe('N/A');
  });
});

describe('formatRuntime', () => {
  it('formats hours and minutes', () => {
    expect(formatRuntime(135)).toBe('2h 15m');
  });

  it('formats minutes only', () => {
    expect(formatRuntime(45)).toBe('45m');
  });

  it('formats exact hours', () => {
    expect(formatRuntime(120)).toBe('2h 0m');
  });

  it('returns N/A for null', () => {
    expect(formatRuntime(null)).toBe('N/A');
  });

  it('returns N/A for undefined', () => {
    expect(formatRuntime(undefined)).toBe('N/A');
  });

  it('returns N/A for 0', () => {
    expect(formatRuntime(0)).toBe('N/A');
  });
});

describe('STATUS_LABELS', () => {
  it('has all expected statuses', () => {
    expect(STATUS_LABELS.watching).toBe('Watching');
    expect(STATUS_LABELS.completed).toBe('Completed');
    expect(STATUS_LABELS.plan_to_watch).toBe('Plan to Watch');
    expect(STATUS_LABELS.dropped).toBe('Dropped');
    expect(STATUS_LABELS.on_hold).toBe('On Hold');
  });

  it('has 5 statuses', () => {
    expect(Object.keys(STATUS_LABELS)).toHaveLength(5);
  });
});

describe('STATUS_COLORS', () => {
  it('has colors for all statuses', () => {
    for (const key of Object.keys(STATUS_LABELS)) {
      expect(STATUS_COLORS[key]).toBeDefined();
    }
  });

  it('colors are tailwind bg classes', () => {
    for (const color of Object.values(STATUS_COLORS)) {
      expect(color).toMatch(/^bg-/);
    }
  });
});
