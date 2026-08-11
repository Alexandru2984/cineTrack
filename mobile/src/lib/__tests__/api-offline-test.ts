import { apiFormDataRequest, apiMultipartRequest, apiRequest } from '@/lib/api';
import {
  ApiError,
  rawFormDataRequest,
  rawMultipartRequest,
  rawRequest,
} from '@/lib/http';
import { currentSessionGeneration, refreshSession } from '@/lib/session';
import { useAuthStore } from '@/store/auth';
import type { User } from '@/types';

jest.mock('@/lib/http', () => ({
  ...jest.requireActual('@/lib/http'),
  rawFormDataRequest: jest.fn(),
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
const mockRawFormDataRequest = jest.mocked(rawFormDataRequest);

/** What the avatar upload sends: one file, streamed natively. */
const avatar = {
  uri: 'file:///cache/ImageManipulator/prepared.jpg',
  fieldName: 'avatar',
  mimeType: 'image/jpeg',
};
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
      apiMultipartRequest('/users/me/avatar', avatar),
    ).rejects.toMatchObject({
      status: 0,
      message: 'Connect to the internet to upload files',
    });
    expect(mockRawMultipartRequest).not.toHaveBeenCalled();
  });

  it('refreshes an expired session before retrying a multipart upload', async () => {
    useAuthStore.getState().setSession('old-access-token', user);
    mockRawMultipartRequest
      .mockRejectedValueOnce(new ApiError('Expired', 401))
      .mockResolvedValueOnce({ avatar_url: 'https://example.test/a.jpg' });
    mockRefreshSession.mockResolvedValueOnce('new-access-token');

    await expect(apiMultipartRequest('/users/me/avatar', avatar)).resolves.toEqual({
      avatar_url: 'https://example.test/a.jpg',
    });
    expect(mockRawMultipartRequest).toHaveBeenNthCalledWith(
      1,
      '/users/me/avatar',
      avatar,
      {
        headers: { Authorization: 'Bearer old-access-token' },
        signal: expect.anything(),
      },
    );
    expect(mockRawMultipartRequest).toHaveBeenNthCalledWith(
      2,
      '/users/me/avatar',
      avatar,
      {
        headers: { Authorization: 'Bearer new-access-token' },
        signal: expect.anything(),
      },
    );
  });

  it('cancels an upload when its account signs out', async () => {
    useAuthStore.getState().setSession('access-token', user);
    mockRawMultipartRequest.mockImplementationOnce(async (_path, _file, options) => {
      useAuthStore.getState().clearSession();
      expect(options?.signal?.aborted).toBe(true);
      throw new ApiError('Cancelled', 0);
    });

    await expect(
      apiMultipartRequest('/users/me/avatar', avatar),
    ).rejects.toMatchObject({ status: 0 });
    expect(mockRefreshSession).not.toHaveBeenCalled();
  });

  // The import still goes through fetch, because it sends three files at once.
  // It shares the session handling and nothing else, so the two paths cannot
  // drift into each other unnoticed.
  it('sends the multi-file import through the form-data path', async () => {
    useAuthStore.getState().setSession('access-token', user);
    const form = new FormData();
    mockRawFormDataRequest.mockResolvedValueOnce({ job_id: 'job-id' });

    await expect(apiFormDataRequest('/import/tvtime', form)).resolves.toEqual({
      job_id: 'job-id',
    });
    expect(mockRawFormDataRequest).toHaveBeenCalledWith('/import/tvtime', form, {
      headers: { Authorization: 'Bearer access-token' },
      signal: expect.anything(),
    });
    expect(mockRawMultipartRequest).not.toHaveBeenCalled();
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
