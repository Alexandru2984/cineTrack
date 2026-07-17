import { apiRequest } from '@/lib/api';
import { deleteAccountSession } from '@/lib/account';
import { clearLocalSession } from '@/lib/session';

jest.mock('@/lib/api', () => ({
  apiRequest: jest.fn(),
}));

jest.mock('@/lib/session', () => ({
  clearLocalSession: jest.fn(),
}));

const mockApiRequest = jest.mocked(apiRequest);
const mockClearLocalSession = jest.mocked(clearLocalSession);

describe('account deletion', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('clears the local session only after the server deletes the account', async () => {
    mockApiRequest.mockResolvedValueOnce({ message: 'Account deleted' });
    mockClearLocalSession.mockResolvedValueOnce();

    await deleteAccountSession('SecurePass1');

    expect(mockApiRequest).toHaveBeenCalledWith('/users/me', {
      method: 'DELETE',
      body: { password: 'SecurePass1' },
    });
    expect(mockClearLocalSession).toHaveBeenCalledTimes(1);
    expect(mockApiRequest.mock.invocationCallOrder[0]).toBeLessThan(
      mockClearLocalSession.mock.invocationCallOrder[0],
    );
  });

  it('keeps the local session when the server rejects the deletion', async () => {
    mockApiRequest.mockRejectedValueOnce(new Error('Password is incorrect'));

    await expect(deleteAccountSession('wrong-password')).rejects.toThrow(
      'Password is incorrect',
    );

    expect(mockClearLocalSession).not.toHaveBeenCalled();
  });
});
