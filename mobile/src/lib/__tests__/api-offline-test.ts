import { apiMultipartRequest, apiRequest } from '@/lib/api';
import { ApiError, rawMultipartRequest, rawRequest } from '@/lib/http';
import { currentSessionGeneration, refreshSession } from '@/lib/session';
import { useAuthStore } from '@/store/auth';
import type { User } from '@/types';

jest.mock('@/lib/http', () => ({
  ...jest.requireActual('@/lib/http'),
  rawMultipartRequest: jest.fn(),
  rawRequest: jest.fn(),
}));

jest.mock('@/lib/session', () => ({
  refreshSession: jest.fn(),
  currentSessionGeneration: jest.fn(() => 0),
}));

const user: User = {
  id: '7d7acbc0-a064-4cb0-a3ea-6c41caa62bc3',
  username: 'offline_user',
  email: 'offline@example.com',
  avatar_url: null,
  bio: null,
  is_public: false,
  created_at: '2026-07-17T00:00:00Z',
};

const mockRawRequest = jest.mocked(rawRequest);
const mockRawMultipartRequest = jest.mocked(rawMultipartRequest);
const mockCurrentSessionGeneration = jest.mocked(currentSessionGeneration);
const mockRefreshSession = jest.mocked(refreshSession);

describe('offline API guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCurrentSessionGeneration.mockReturnValue(0);
    useAuthStore.getState().clearSession();
  });

  it('fails authenticated requests before sending them without a token', async () => {
    useAuthStore.getState().setOfflineSession(user);

    await expect(
      apiRequest('/lists/list-1', { method: 'PATCH', body: { name: 'Nope' } }),
    ).rejects.toMatchObject({
      status: 0,
      message: 'Connect to the internet to make changes',
    });
    expect(mockRawRequest).not.toHaveBeenCalled();
  });

  it('fails multipart uploads offline before reading the selected files', async () => {
    useAuthStore.getState().setOfflineSession(user);

    await expect(
      apiMultipartRequest('/import/tvtime', new FormData()),
    ).rejects.toMatchObject({
      status: 0,
      message: 'Connect to the internet to import data',
    });
    expect(mockRawMultipartRequest).not.toHaveBeenCalled();
  });

  it('refreshes an expired session before retrying a multipart upload', async () => {
    useAuthStore.getState().setSession('old-access-token', user);
    const form = new FormData();
    mockRawMultipartRequest
      .mockRejectedValueOnce(new ApiError('Expired', 401))
      .mockResolvedValueOnce({ job_id: 'job-id' });
    mockRefreshSession.mockResolvedValueOnce('new-access-token');

    await expect(apiMultipartRequest('/import/tvtime', form)).resolves.toEqual({
      job_id: 'job-id',
    });
    expect(mockRawMultipartRequest).toHaveBeenNthCalledWith(
      1,
      '/import/tvtime',
      form,
      {
        headers: { Authorization: 'Bearer old-access-token' },
        signal: expect.anything(),
      },
    );
    expect(mockRawMultipartRequest).toHaveBeenNthCalledWith(
      2,
      '/import/tvtime',
      form,
      {
        headers: { Authorization: 'Bearer new-access-token' },
        signal: expect.anything(),
      },
    );
  });

  it('cancels an upload when its account signs out', async () => {
    useAuthStore.getState().setSession('access-token', user);
    mockRawMultipartRequest.mockImplementationOnce(async (_path, _form, options) => {
      useAuthStore.getState().clearSession();
      expect(options?.signal?.aborted).toBe(true);
      throw new ApiError('Cancelled', 0);
    });

    await expect(
      apiMultipartRequest('/import/tvtime', new FormData()),
    ).rejects.toMatchObject({ status: 0 });
    expect(mockRefreshSession).not.toHaveBeenCalled();
  });

  it('does not retry a request after the active account changes', async () => {
    useAuthStore.getState().setSession('old-access-token', user);
    mockRawRequest.mockRejectedValueOnce(new ApiError('Expired', 401));
    mockRefreshSession.mockImplementationOnce(async () => {
      mockCurrentSessionGeneration.mockReturnValue(1);
      return 'new-access-token';
    });

    await expect(apiRequest('/tracking')).rejects.toMatchObject({
      status: 401,
      message: 'Session changed while the request was in progress',
    });
    expect(mockRawRequest).toHaveBeenCalledTimes(1);
  });
});
