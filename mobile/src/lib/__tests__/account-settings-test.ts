import {
  changeAccountPassword,
  listAccountSessions,
  logoutAllAccountSessions,
  MAX_PROFILE_BIO_LENGTH,
  updateAccountProfile,
  validatePasswordChange,
  validateProfileDraft,
} from '@/lib/account';
import { apiRequest } from '@/lib/api';
import { ApiError, rawRequest } from '@/lib/http';
import { readRefreshToken } from '@/lib/secure-session';
import { clearLocalSession } from '@/lib/session';

jest.mock('@/lib/api', () => ({ apiRequest: jest.fn() }));
jest.mock('@/lib/secure-session', () => ({ readRefreshToken: jest.fn() }));
jest.mock('@/lib/session', () => ({ clearLocalSession: jest.fn() }));
jest.mock('@/lib/http', () => {
  const actual = jest.requireActual('@/lib/http');
  return { ...actual, rawRequest: jest.fn() };
});

const mockApiRequest = jest.mocked(apiRequest);
const mockRawRequest = jest.mocked(rawRequest);
const mockReadRefreshToken = jest.mocked(readRefreshToken);
const mockClearLocalSession = jest.mocked(clearLocalSession);

describe('mobile account settings', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('normalizes a validated profile update', async () => {
    const updatedUser = { id: 'user-1' };
    mockApiRequest.mockResolvedValueOnce(updatedUser);

    expect(validateProfileDraft('  film-buff  ', 'About me')).toBeNull();
    await expect(updateAccountProfile({
      username: '  film-buff  ',
      bio: '  About me  ',
      isPublic: false,
    })).resolves.toBe(updatedUser);
    expect(mockApiRequest).toHaveBeenCalledWith('/users/me', {
      method: 'PATCH',
      body: { username: 'film-buff', bio: 'About me', is_public: false },
    });
  });

  it('matches profile and password limits enforced by the API', () => {
    expect(validateProfileDraft('_unsafe', '')).toMatch(/starting and ending/);
    expect(validateProfileDraft('film_buff', 'x'.repeat(MAX_PROFILE_BIO_LENGTH + 1)))
      .toMatch(/at most 500/);
    expect(validatePasswordChange('', 'Password1', 'Password1')).toMatch(/current/);
    expect(validatePasswordChange('OldPass1', 'password', 'password')).toMatch(/number/);
    expect(validatePasswordChange('OldPass1', 'Password1', 'Password2')).toMatch(/match/);
    expect(validatePasswordChange('OldPass1', 'Password1', 'Password1')).toBeNull();
  });

  it('lists sessions with the refresh token without placing it in the URL', async () => {
    const refreshToken = 'a'.repeat(128);
    const sessions = [{ id: 'session-1', current: true }];
    mockReadRefreshToken.mockResolvedValueOnce(refreshToken);
    mockRawRequest.mockResolvedValueOnce(sessions);

    await expect(listAccountSessions()).resolves.toBe(sessions);
    expect(mockRawRequest).toHaveBeenCalledWith('/auth/mobile/sessions', {
      method: 'POST',
      body: { refresh_token: refreshToken },
    });
  });

  it('retries session listing only when SecureStore contains a rotated token', async () => {
    const previousToken = 'a'.repeat(128);
    const currentToken = 'b'.repeat(128);
    mockReadRefreshToken
      .mockResolvedValueOnce(previousToken)
      .mockResolvedValueOnce(currentToken);
    mockRawRequest
      .mockRejectedValueOnce(new ApiError('Invalid refresh token', 401))
      .mockResolvedValueOnce([]);

    await expect(listAccountSessions()).resolves.toEqual([]);
    expect(mockRawRequest).toHaveBeenLastCalledWith('/auth/mobile/sessions', {
      method: 'POST',
      body: { refresh_token: currentToken },
    });
  });

  it('does not clear a session after a rejected password change', async () => {
    mockApiRequest.mockRejectedValueOnce(new ApiError('Password is incorrect', 401));

    await expect(changeAccountPassword('wrong', 'Password2')).rejects.toThrow(
      'Password is incorrect',
    );
    expect(mockClearLocalSession).not.toHaveBeenCalled();
  });

  it('clears local credentials after password change and sign-out everywhere', async () => {
    mockApiRequest.mockResolvedValue({ message: 'ok' });
    mockClearLocalSession.mockResolvedValue();

    await changeAccountPassword('Password1', 'Password2');
    await logoutAllAccountSessions();

    expect(mockClearLocalSession).toHaveBeenCalledTimes(2);
    expect(mockApiRequest).toHaveBeenNthCalledWith(1, '/auth/password', {
      method: 'PATCH',
      body: { current_password: 'Password1', new_password: 'Password2' },
    });
    expect(mockApiRequest).toHaveBeenNthCalledWith(2, '/auth/sessions/logout-all', {
      method: 'POST',
    });
  });
});
