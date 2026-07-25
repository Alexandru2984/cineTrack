import { z } from 'zod';

import { apiRequest } from '@/lib/api';
import { ApiError, withQuery } from '@/lib/http';
import type { WrappedStats } from '@/types';

const nonNegativeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const calendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const [year, month, day] = value.split('-').map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return (
      parsed.getUTCFullYear() === year &&
      parsed.getUTCMonth() === month - 1 &&
      parsed.getUTCDate() === day
    );
  }, 'Invalid calendar date');

const genreSchema = z.object({
  genre: z.string().trim().min(1).max(100),
  count: nonNegativeInteger,
});

const titleSchema = z.object({
  tmdb_id: z.number().int().positive().max(2_147_483_647),
  media_type: z.enum(['movie', 'tv']),
  title: z.string().trim().min(1).max(300),
  poster_path: z
    .string()
    .regex(/^\/[A-Za-z0-9_-]+\.(?:png|jpe?g|webp)$/i)
    .max(200)
    .nullable(),
  count: nonNegativeInteger,
});

const wrappedStatsSchema = z
  .object({
    year: z.number().int().min(1900).max(2100),
    total_watches: nonNegativeInteger,
    movies_watched: nonNegativeInteger,
    episodes_watched: nonNegativeInteger,
    distinct_titles: nonNegativeInteger,
    total_hours: z.number().finite().nonnegative(),
    longest_streak: nonNegativeInteger,
    first_watch: calendarDateSchema.nullable(),
    last_watch: calendarDateSchema.nullable(),
    top_genres: z.array(genreSchema).max(5),
    top_shows: z.array(titleSchema).max(5),
    monthly: z
      .array(
        z.object({
          month: z.number().int().min(1).max(12),
          count: nonNegativeInteger,
        }),
      )
      .length(12),
  })
  .superRefine((value, context) => {
    const months = new Set(value.monthly.map((entry) => entry.month));
    if (months.size !== 12) {
      context.addIssue({
        code: 'custom',
        path: ['monthly'],
        message: 'Monthly recap must contain each month exactly once',
      });
    }
    if (value.movies_watched + value.episodes_watched !== value.total_watches) {
      context.addIssue({
        code: 'custom',
        path: ['total_watches'],
        message: 'Watch totals are inconsistent',
      });
    }
    if (
      value.monthly.reduce((total, entry) => total + entry.count, 0) !==
      value.total_watches
    ) {
      context.addIssue({
        code: 'custom',
        path: ['monthly'],
        message: 'Monthly totals are inconsistent',
      });
    }
    if (value.distinct_titles > value.total_watches) {
      context.addIssue({
        code: 'custom',
        path: ['distinct_titles'],
        message: 'Distinct title total is inconsistent',
      });
    }
    for (const [field, date] of [
      ['first_watch', value.first_watch],
      ['last_watch', value.last_watch],
    ] as const) {
      if (date && Number(date.slice(0, 4)) !== value.year) {
        context.addIssue({
          code: 'custom',
          path: [field],
          message: 'Watch date is outside the recap year',
        });
      }
    }
    if (value.first_watch && value.last_watch && value.first_watch > value.last_watch) {
      context.addIssue({
        code: 'custom',
        path: ['last_watch'],
        message: 'Watch date range is reversed',
      });
    }
  });

export async function fetchWrapped(year: number): Promise<WrappedStats> {
  if (!Number.isInteger(year) || year < 1900 || year > 2100) {
    throw new ApiError('Year must be between 1900 and 2100', 400);
  }
  const payload = await apiRequest<unknown>(
    withQuery('/stats/me/wrapped', { year }),
  );
  const result = wrappedStatsSchema.parse(payload);
  if (result.year !== year) {
    throw new ApiError('The recap response did not match the requested year', 502);
  }
  return result as WrappedStats;
}
