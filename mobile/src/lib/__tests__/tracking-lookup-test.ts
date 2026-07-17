import { buildTrackingLookupBatches } from '@/lib/tracking-lookup';

describe('tracking lookup batching', () => {
  it('keeps every title when a library lookup exceeds one API batch', () => {
    const targets = Array.from({ length: 205 }, (_, index) => ({
      tmdb_id: index + 1,
      media_type: 'movie' as const,
    }));

    const batches = buildTrackingLookupBatches(targets);

    expect(batches.map((batch) => batch.length)).toEqual([100, 100, 5]);
    expect(batches.flat()).toEqual(targets);
  });

  it('deduplicates exact pairs while keeping movie and TV ids distinct', () => {
    const batches = buildTrackingLookupBatches([
      { tmdb_id: 42, media_type: 'movie' },
      { tmdb_id: 42, media_type: 'movie' },
      { tmdb_id: 42, media_type: 'tv' },
      { tmdb_id: 0, media_type: 'movie' },
    ]);

    expect(batches).toEqual([[
      { tmdb_id: 42, media_type: 'movie' },
      { tmdb_id: 42, media_type: 'tv' },
    ]]);
  });
});
