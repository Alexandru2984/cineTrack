import { apiRequest } from '@/lib/api';
import { fetchCommunityRating } from '@/lib/community-rating';

jest.mock('@/lib/api', () => ({
  apiRequest: jest.fn(),
}));

const mockApiRequest = jest.mocked(apiRequest);

describe('mobile community rating', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('parses an above-floor aggregate', async () => {
    mockApiRequest.mockResolvedValueOnce({
      count: 4,
      average: 8.5,
      // index 0 = one star … index 9 = ten stars
      distribution: [0, 0, 0, 0, 0, 1, 0, 1, 0, 2],
    });
    const result = await fetchCommunityRating('603', 'movie');
    expect(result.count).toBe(4);
    expect(result.average).toBe(8.5);
    expect(result.distribution).toHaveLength(10);
  });

  it('parses a below-floor aggregate where average and distribution are withheld', async () => {
    mockApiRequest.mockResolvedValueOnce({ count: 2, average: null, distribution: null });
    const result = await fetchCommunityRating('603', 'movie');
    expect(result).toEqual({ count: 2, average: null, distribution: null });
  });

  it('rejects a distribution that is not exactly ten buckets', async () => {
    mockApiRequest.mockResolvedValueOnce({ count: 5, average: 7, distribution: [1, 2, 3] });
    await expect(fetchCommunityRating('603', 'movie')).rejects.toThrow();
  });

  it('requests the aggregate endpoint with the media type', async () => {
    mockApiRequest.mockResolvedValueOnce({ count: 0, average: null, distribution: null });
    await fetchCommunityRating('12345', 'tv');
    const requested = mockApiRequest.mock.calls[0]?.[0] as string;
    expect(requested).toContain('/media/12345/community-rating');
    expect(requested).toContain('type=tv');
  });
});
