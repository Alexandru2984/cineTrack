import AsyncStorage from '@react-native-async-storage/async-storage';

import { apiRequest } from '@/lib/api';
import {
  captureClientError,
  clearClientErrorReports,
  flushClientErrorReports,
  sanitizeDiagnosticText,
} from '@/lib/client-errors';
import { ApiError } from '@/lib/http';
import { useAuthStore } from '@/store/auth';
import type { User } from '@/types';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(),
    setItem: jest.fn(),
    removeItem: jest.fn(),
  },
}));

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { version: '1.0.0' } },
}));

jest.mock('@/lib/api', () => ({ apiRequest: jest.fn() }));

const user: User = {
  id: '7d7acbc0-a064-4cb0-a3ea-6c41caa62bc3',
  username: 'diagnostics_user',
  email: 'diagnostics@example.com',
  avatar_url: null,
  bio: null,
  is_public: false,
  created_at: '2026-07-17T00:00:00Z',
};

const secondUser: User = {
  ...user,
  id: '966900b2-a6d7-42a9-9a58-f8a4880df021',
  username: 'other_user',
  email: 'other@example.com',
};

const mockApiRequest = jest.mocked(apiRequest);
const mockGetItem = jest.mocked(AsyncStorage.getItem);
const mockSetItem = jest.mocked(AsyncStorage.setItem);
const mockRemoveItem = jest.mocked(AsyncStorage.removeItem);
let storedValue: string | null;

describe('self-hosted client error reporting', () => {
  beforeEach(async () => {
    storedValue = null;
    mockGetItem.mockImplementation(async () => storedValue);
    mockSetItem.mockImplementation(async (_key, value) => {
      storedValue = value;
    });
    mockRemoveItem.mockImplementation(async () => {
      storedValue = null;
    });
    useAuthStore.getState().clearSession();
    await clearClientErrorReports();
    jest.clearAllMocks();
  });

  it('redacts credentials, contact data, and URL parameters', () => {
    const text = sanitizeDiagnosticText(
      'Authorization: Bearer secret alex@example.com ' +
        'https://example.com/path?token=secret#private ' +
        'abcdefghijklmnopqrstuvwxyz1234567890',
      1000,
    );

    expect(text).toContain('Authorization: Bearer [redacted]');
    expect(text).toContain('[redacted-email]');
    expect(text).toContain('https://example.com/path');
    expect(text).toContain('[redacted-token]');
    expect(text).not.toContain('secret');
    expect(text).not.toContain('alex@example.com');
    expect(text).not.toContain('?token=');
  });

  it('bounds diagnostic text by Unicode characters', () => {
    expect(Array.from(sanitizeDiagnosticText('é'.repeat(20), 8))).toHaveLength(8);
  });

  it('queues a sanitized report while the saved account is offline', async () => {
    useAuthStore.getState().setOfflineSession(user);
    const error = new Error('Failed for diagnostics@example.com Bearer private-token');

    await captureClientError(error, { isFatal: true });

    expect(mockApiRequest).not.toHaveBeenCalled();
    const queue = JSON.parse(storedValue ?? '[]') as {
      owner_id: string;
      report: { message: string; is_fatal: boolean; app_version: string };
    }[];
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      owner_id: user.id,
      report: { is_fatal: true, app_version: '1.0.0' },
    });
    expect(queue[0].report.message).not.toContain(user.email);
    expect(queue[0].report.message).not.toContain('private-token');
  });

  it('sends immediately when authenticated', async () => {
    useAuthStore.getState().setSession('access-token', user);
    mockApiRequest.mockResolvedValueOnce(undefined);

    await captureClientError(new TypeError('Render failed'));

    expect(mockApiRequest).toHaveBeenCalledWith('/client-errors', {
      method: 'POST',
      body: expect.objectContaining({
        error_name: 'TypeError',
        message: 'Render failed',
        is_fatal: false,
      }),
    });
    expect(mockSetItem).not.toHaveBeenCalled();
  });

  it('queues temporary failures and flushes them after recovery', async () => {
    useAuthStore.getState().setSession('access-token', user);
    mockApiRequest.mockRejectedValueOnce(new ApiError('Unavailable', 503));

    await captureClientError(new Error('Temporary report'));
    expect(storedValue).not.toBeNull();

    mockApiRequest.mockResolvedValueOnce(undefined);
    await flushClientErrorReports();

    expect(mockApiRequest).toHaveBeenCalledTimes(2);
    expect(storedValue).toBeNull();
  });

  it('does not retain reports rejected as invalid', async () => {
    useAuthStore.getState().setSession('access-token', user);
    mockApiRequest.mockRejectedValueOnce(new ApiError('Invalid report', 400));

    await captureClientError(new Error('Rejected report'));

    expect(mockApiRequest).toHaveBeenCalledTimes(1);
    expect(mockSetItem).not.toHaveBeenCalled();
  });

  it('deduplicates repeated offline reports and does not cross accounts', async () => {
    useAuthStore.getState().setOfflineSession(user);
    await captureClientError(new Error('Repeated report'));
    await captureClientError(new Error('Repeated report'));

    expect(JSON.parse(storedValue ?? '[]')).toHaveLength(1);

    useAuthStore.getState().setSession('other-access-token', secondUser);
    await flushClientErrorReports();

    expect(mockApiRequest).not.toHaveBeenCalled();
    expect(JSON.parse(storedValue ?? '[]')).toHaveLength(1);
  });

  it('does not enqueue a failed report after its account signs out', async () => {
    useAuthStore.getState().setSession('access-token', user);
    mockApiRequest.mockImplementationOnce(async () => {
      useAuthStore.getState().clearSession();
      throw new ApiError('Connection lost', 0);
    });

    await captureClientError(new Error('Logout race'));

    expect(mockSetItem).not.toHaveBeenCalled();
    expect(storedValue).toBeNull();
  });
});
