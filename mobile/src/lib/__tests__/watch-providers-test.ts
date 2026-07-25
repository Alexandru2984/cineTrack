import { apiRequest } from '@/lib/api';
import {
  fetchWatchProviders,
  safeWatchProviderLink,
} from '@/lib/watch-providers';

jest.mock('@/lib/api', () => ({
  apiRequest: jest.fn(),
}));

const mockApiRequest = jest.mocked(apiRequest);

describe('mobile watch providers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('accepts only trusted HTTPS attribution links', () => {
    expect(
      safeWatchProviderLink('https://www.themoviedb.org/movie/603/watch#offers'),
    ).toBe('https://www.themoviedb.org/movie/603/watch');
    expect(safeWatchProviderLink('https://ro.justwatch.com/title/603')).toBe(
      'https://ro.justwatch.com/title/603',
    );
    expect(safeWatchProviderLink('https://justwatch.com@attacker.test/title')).toBe(
      'https://www.justwatch.com/',
    );
    expect(safeWatchProviderLink('http://www.justwatch.com/title')).toBe(
      'https://www.justwatch.com/',
    );
    expect(safeWatchProviderLink('not a url')).toBe('https://www.justwatch.com/');
  });

  it('validates regional offers returned by the API', async () => {
    mockApiRequest.mockResolvedValueOnce({
      region: 'RO',
      link: 'https://www.themoviedb.org/movie/603/watch',
      stream: [
        {
          provider_id: 8,
          name: 'Netflix',
          logo_path: '/netflix_logo.jpg',
        },
      ],
      rent: [],
      buy: [],
    });

    await expect(fetchWatchProviders('603', 'movie')).resolves.toMatchObject({
      region: 'RO',
      stream: [{ name: 'Netflix' }],
    });
    expect(mockApiRequest).toHaveBeenCalledWith(
      '/media/603/watch-providers?type=movie',
    );
  });

  it('rejects malformed regions and unsafe logo paths', async () => {
    mockApiRequest
      .mockResolvedValueOnce({
        region: '../../',
        link: null,
        stream: [],
        rent: [],
        buy: [],
      })
      .mockResolvedValueOnce({
        region: 'RO',
        link: null,
        stream: [
          {
            provider_id: 8,
            name: 'Provider',
            logo_path: '/../private.png',
          },
        ],
        rent: [],
        buy: [],
      });

    await expect(fetchWatchProviders('603', 'movie')).rejects.toThrow();
    await expect(fetchWatchProviders('603', 'movie')).rejects.toThrow();
  });
});
