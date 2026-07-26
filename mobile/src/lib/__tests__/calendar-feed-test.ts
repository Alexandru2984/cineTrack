import { apiRequest } from '@/lib/api';
import {
  disableCalendarFeed,
  enableCalendarFeed,
  fetchCalendarFeedStatus,
} from '@/lib/calendar-feed';

jest.mock('@/lib/api', () => ({
  apiRequest: jest.fn(),
}));

const mockApiRequest = jest.mocked(apiRequest);

describe('mobile calendar feed', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('parses the feed status', async () => {
    mockApiRequest.mockResolvedValueOnce({ enabled: true });
    expect(await fetchCalendarFeedStatus()).toEqual({ enabled: true });
  });

  it('parses the credential returned when enabling', async () => {
    mockApiRequest.mockResolvedValueOnce({
      feed_url: 'https://vazute.micutu.com/api/calendar/feed/abc.ics',
    });
    const credential = await enableCalendarFeed();
    expect(credential.feed_url).toContain('/calendar/feed/');
    expect(mockApiRequest).toHaveBeenCalledWith('/calendar/feed', { method: 'POST' });
  });

  it('rejects a malformed feed_url', async () => {
    mockApiRequest.mockResolvedValueOnce({ feed_url: 'not a url' });
    await expect(enableCalendarFeed()).rejects.toThrow();
  });

  it('disables via DELETE', async () => {
    mockApiRequest.mockResolvedValueOnce(undefined);
    await disableCalendarFeed();
    expect(mockApiRequest).toHaveBeenCalledWith('/calendar/feed', { method: 'DELETE' });
  });
});
