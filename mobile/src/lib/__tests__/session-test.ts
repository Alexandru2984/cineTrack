import { ApiError, rawRequest } from '@/lib/http';
import {
  readRefreshToken,
  removeRefreshToken,
  writeRefreshToken,
} from '@/lib/secure-session';
import { hydrateSession, refreshSession } from '@/lib/session';
import { useAuthStore } from '@/store/auth';
import type { MobileAuthResponse, User } from '@/types';

jest.mock('@/lib/http', () => ({
  ...jest.requireActual('@/lib/http'),
  rawRequest: jest.fn(),
}));

jest.mock('@/lib/secure-session', () => ({
  readRefreshToken: jest.fn(),
  removeRefreshToken: jest.fn(),
  writeRefreshToken: jest.fn(),
}));

const user: User = {
  id: '7d7acbc0-a064-4cb0-a3ea-6c41caa62bc3',
  username: 'mobile_user',
  email: 'mobile@example.com',
  avatar_url: null,
  bio: null,
  is_public: false,
  created_at: '2026-07-17T00:00:00Z',
};

const refreshToken = 'r'.repeat(64);
const response: MobileAuthResponse = {
  access_token: 'new-access-token',
  refresh_token: 'n'.repeat(64),
  token_type: 'Bearer',
  expires_in: 900,
  user,
};

const mockRawRequest = jest.mocked(rawRequest);
const mockReadRefreshToken = jest.mocked(readRefreshToken);
const mockRemoveRefreshToken = jest.mocked(removeRefreshToken);
const mockWriteRefreshToken = jest.mocked(writeRefreshToken);

describe('mobile session recovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useAuthStore.getState().clearSession();
    mockReadRefreshToken.mockResolvedValue(refreshToken);
    mockRemoveRefreshToken.mockResolvedValue();
    mockWriteRefreshToken.mockResolvedValue();
  });

  it.each([
    ['network failure', 0],
    ['server failure', 503],
  ])('keeps the refresh token when hydration hits a %s', async (_label, status) => {
    mockRawRequest.mockRejectedValueOnce(new ApiError('Temporary failure', status));

    await hydrateSession();

    expect(mockRemoveRefreshToken).not.toHaveBeenCalled();
    expect(useAuthStore.getState().status).toBe('restore_error');
  });

  it('discards a refresh token rejected with 401 during hydration', async () => {
    mockRawRequest.mockRejectedValueOnce(new ApiError('Invalid token', 401));

    await hydrateSession();

    expect(mockRemoveRefreshToken).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().status).toBe('anonymous');
  });

  it('keeps an active session when a background refresh loses connectivity', async () => {
    useAuthStore.getState().setSession('old-access-token', user);
    mockRawRequest.mockRejectedValueOnce(new ApiError('Offline', 0));

    await expect(refreshSession()).rejects.toMatchObject({ status: 0 });

    expect(mockRemoveRefreshToken).not.toHaveBeenCalled();
    expect(useAuthStore.getState()).toMatchObject({
      status: 'authenticated',
      accessToken: 'old-access-token',
      user,
    });
  });

  it('clears an active session when refresh is rejected with 401', async () => {
    useAuthStore.getState().setSession('old-access-token', user);
    mockRawRequest.mockRejectedValueOnce(new ApiError('Invalid token', 401));

    await expect(refreshSession()).rejects.toMatchObject({ status: 401 });

    expect(mockRemoveRefreshToken).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().status).toBe('anonymous');
  });

  it('accepts and rotates a valid session during hydration', async () => {
    mockRawRequest.mockResolvedValueOnce(response);

    await hydrateSession();

    expect(mockWriteRefreshToken).toHaveBeenCalledWith(response.refresh_token);
    expect(useAuthStore.getState()).toMatchObject({
      status: 'authenticated',
      accessToken: response.access_token,
      user,
    });
  });
});
