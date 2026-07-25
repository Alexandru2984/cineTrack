import { apiRequest } from '@/lib/api';
import { fetchWrapped } from '@/lib/wrapped';

jest.mock('@/lib/api', () => ({
  apiRequest: jest.fn(),
}));

const mockApiRequest = jest.mocked(apiRequest);

function recap(overrides: Record<string, unknown> = {}) {
  return {
    year: 2026,
    total_watches: 66,
    movies_watched: 6,
    episodes_watched: 60,
    distinct_titles: 9,
    total_hours: 15.5,
    longest_streak: 4,
    first_watch: '2026-01-03',
    last_watch: '2026-07-25',
    top_genres: [{ genre: 'Drama', count: 5 }],
    top_shows: [
      {
        tmdb_id: 603,
        media_type: 'movie',
        title: 'The Matrix',
        poster_path: '/matrix.jpg',
        count: 2,
      },
    ],
    monthly: Array.from({ length: 12 }, (_, index) => ({
      month: index + 1,
      count: index,
    })),
    ...overrides,
  };
}

describe('mobile annual recap', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('loads and validates a complete year-scoped recap', async () => {
    mockApiRequest.mockResolvedValueOnce(recap());

    await expect(fetchWrapped(2026)).resolves.toMatchObject({
      year: 2026,
      total_watches: 66,
      top_shows: [{ media_type: 'movie', tmdb_id: 603 }],
    });
    expect(mockApiRequest).toHaveBeenCalledWith('/stats/me/wrapped?year=2026');
  });

  it('rejects mismatched years, invalid dates, and duplicate months', async () => {
    mockApiRequest
      .mockResolvedValueOnce(
        recap({
          year: 2025,
          first_watch: '2025-01-03',
          last_watch: '2025-07-25',
        }),
      )
      .mockResolvedValueOnce(recap({ first_watch: '2026-02-30' }))
      .mockResolvedValueOnce(
        recap({
          monthly: Array.from({ length: 12 }, (_, index) => ({
            month: index === 11 ? 11 : index + 1,
            count: 0,
          })),
        }),
      );

    await expect(fetchWrapped(2026)).rejects.toThrow(
      'The recap response did not match the requested year',
    );
    await expect(fetchWrapped(2026)).rejects.toThrow();
    await expect(fetchWrapped(2026)).rejects.toThrow(
      'Monthly recap must contain each month exactly once',
    );
  });

  it('rejects invalid requested years before making a request', async () => {
    await expect(fetchWrapped(1899)).rejects.toMatchObject({ status: 400 });
    await expect(fetchWrapped(2026.5)).rejects.toMatchObject({ status: 400 });
    expect(mockApiRequest).not.toHaveBeenCalled();
  });
});
