import { ApiError, isTwoFactorRequired, rawRequest } from '@/lib/http';
import { loginSession } from '@/lib/session';

jest.mock('@/lib/http', () => {
  const actual = jest.requireActual('@/lib/http');
  return { ...actual, rawRequest: jest.fn() };
});
jest.mock('@/lib/secure-session', () => ({
  writeRefreshToken: jest.fn(),
  writeCachedSession: jest.fn(),
  removeCachedSession: jest.fn(),
  removeRefreshToken: jest.fn(),
  readCachedSession: jest.fn(),
  readRefreshToken: jest.fn(),
}));
jest.mock('@/lib/secure-release-notifications', () => ({
  detachStoredReleaseNotifications: jest.fn(),
}));

const mockRawRequest = jest.mocked(rawRequest);

const SESSION = {
  access_token: 'access-token',
  refresh_token: 'r'.repeat(64),
  token_type: 'Bearer',
  expires_in: 900,
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    username: 'micu',
    email: 'micu@example.com',
    avatar_url: null,
    bio: null,
    is_public: true,
    created_at: '2026-01-01T00:00:00Z',
  },
};

describe('two-factor login on mobile', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRawRequest.mockResolvedValue(SESSION);
  });

  it('omits totp_code on the first attempt', async () => {
    await loginSession('micu@example.com', 'secret');

    expect(mockRawRequest).toHaveBeenCalledWith(
      '/auth/mobile/login',
      expect.objectContaining({
        body: { email: 'micu@example.com', password: 'secret' },
      }),
    );
  });

  it('sends a trimmed totp_code when retrying after the challenge', async () => {
    await loginSession('micu@example.com', 'secret', ' 123456 ');

    expect(mockRawRequest).toHaveBeenCalledWith(
      '/auth/mobile/login',
      expect.objectContaining({
        body: { email: 'micu@example.com', password: 'secret', totp_code: '123456' },
      }),
    );
  });

  it('accepts a recovery code as the second factor', async () => {
    await loginSession('micu@example.com', 'secret', 'aaaa-bbbb-cccc-dddd');

    expect(mockRawRequest).toHaveBeenCalledWith(
      '/auth/mobile/login',
      expect.objectContaining({
        body: expect.objectContaining({ totp_code: 'aaaa-bbbb-cccc-dddd' }),
      }),
    );
  });

  it('detects the backend two-factor challenge', () => {
    const challenge = new ApiError('Two-factor authentication code required', 401, {
      two_factor_required: true,
    });
    expect(isTwoFactorRequired(challenge)).toBe(true);
  });

  it('does not mistake a plain credential error for a challenge', () => {
    expect(isTwoFactorRequired(new ApiError('Invalid email or password', 401))).toBe(false);
    expect(isTwoFactorRequired(new ApiError('Invalid two-factor code', 401, {}))).toBe(false);
    expect(isTwoFactorRequired(new Error('offline'))).toBe(false);
  });
});
