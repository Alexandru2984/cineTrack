import { apiRequest } from '@/lib/api';
import { rawRequest } from '@/lib/http';
import { useAuthStore } from '@/store/auth';
import type { User } from '@/types';

jest.mock('@/lib/http', () => ({
  ...jest.requireActual('@/lib/http'),
  rawRequest: jest.fn(),
}));

jest.mock('@/lib/session', () => ({
  refreshSession: jest.fn(),
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

describe('offline API guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
});
