import * as SecureStore from 'expo-secure-store';
import * as Notifications from 'expo-notifications';

import { apiRequest } from '@/lib/api';
import { ApiError, rawRequest } from '@/lib/http';
import {
  disableReleaseNotifications,
  enableReleaseNotifications,
  flushPendingPushRevocations,
  releaseNotificationRoute,
  syncReleaseNotifications,
} from '@/lib/release-notifications';
import {
  readPendingPushRevocations,
  writeStoredReleaseNotifications,
} from '@/lib/secure-release-notifications';
import { useAuthStore } from '@/store/auth';
import type { User } from '@/types';

jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked-this-device-only',
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

jest.mock('expo-crypto', () => ({
  getRandomBytesAsync: jest.fn(async () => new Uint8Array(32).fill(0xab)),
}));

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: {
    easConfig: { projectId: 'b036a54f-066e-41e1-8c33-80f324d410fe' },
    expoConfig: { version: '1.1.0' },
  },
}));

jest.mock('expo-notifications', () => ({
  AndroidImportance: { DEFAULT: 5 },
  AndroidNotificationVisibility: { PRIVATE: 2 },
  DEFAULT_ACTION_IDENTIFIER: 'default',
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn(),
  setNotificationChannelAsync: jest.fn(),
  setNotificationHandler: jest.fn(),
  getLastNotificationResponse: jest.fn(() => null),
  clearLastNotificationResponse: jest.fn(),
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
}));

jest.mock('@/lib/api', () => ({ apiRequest: jest.fn() }));
jest.mock('@/lib/http', () => ({
  ...jest.requireActual('@/lib/http'),
  rawRequest: jest.fn(),
}));

const user: User = {
  id: '7d7acbc0-a064-4cb0-a3ea-6c41caa62bc3',
  username: 'push_user',
  email: 'push@example.com',
  avatar_url: null,
  bio: null,
  is_public: false,
  created_at: '2026-07-17T00:00:00Z',
};
const expoToken = 'ExpoPushToken[abcdefghijklmnopqrstuv]';
const granted = { status: 'granted', granted: true, expires: 'never', canAskAgain: true };
const undetermined = {
  status: 'undetermined',
  granted: false,
  expires: 'never',
  canAskAgain: true,
};
const denied = { status: 'denied', granted: false, expires: 'never', canAskAgain: false };

const mockApiRequest = jest.mocked(apiRequest);
const mockRawRequest = jest.mocked(rawRequest);
const mockGetPermissions = jest.mocked(Notifications.getPermissionsAsync);
const mockRequestPermissions = jest.mocked(Notifications.requestPermissionsAsync);
const mockGetExpoPushToken = jest.mocked(Notifications.getExpoPushTokenAsync);
const mockGetItem = jest.mocked(SecureStore.getItemAsync);
const mockSetItem = jest.mocked(SecureStore.setItemAsync);
const mockDeleteItem = jest.mocked(SecureStore.deleteItemAsync);
const storage = new Map<string, string>();

describe('release push notifications', () => {
  beforeEach(() => {
    storage.clear();
    jest.clearAllMocks();
    mockGetItem.mockImplementation(async (key) => storage.get(key) ?? null);
    mockSetItem.mockImplementation(async (key, value) => {
      storage.set(key, value);
    });
    mockDeleteItem.mockImplementation(async (key) => {
      storage.delete(key);
    });
    mockGetPermissions.mockResolvedValue(granted as never);
    mockRequestPermissions.mockResolvedValue(granted as never);
    mockGetExpoPushToken.mockResolvedValue({ type: 'expo', data: expoToken });
    mockApiRequest.mockResolvedValue(undefined);
    mockRawRequest.mockResolvedValue(undefined);
    useAuthStore.getState().setSession('access-token', user);
  });

  it('registers an explicitly enabled device without prompting twice', async () => {
    const state = await enableReleaseNotifications(user.id);

    expect(mockRequestPermissions).not.toHaveBeenCalled();
    expect(mockGetExpoPushToken).toHaveBeenCalledWith({
      projectId: 'b036a54f-066e-41e1-8c33-80f324d410fe',
    });
    expect(mockApiRequest).toHaveBeenCalledWith('/push/devices', {
      method: 'PUT',
      body: expect.objectContaining({
        expo_push_token: expoToken,
        unregister_secret: 'ab'.repeat(32),
        app_version: '1.1.0',
      }),
    });
    expect(state).toMatchObject({ enabled: true, pending: false, permission: 'granted' });
  });

  it('does not register when the user denies the explicit permission request', async () => {
    mockGetPermissions
      .mockResolvedValueOnce(undetermined as never)
      .mockResolvedValue(denied as never);
    mockRequestPermissions.mockResolvedValue(denied as never);

    const state = await enableReleaseNotifications(user.id);

    expect(mockRequestPermissions).toHaveBeenCalledTimes(1);
    expect(mockGetExpoPushToken).not.toHaveBeenCalled();
    expect(mockApiRequest).not.toHaveBeenCalled();
    expect(state).toMatchObject({ enabled: false, permission: 'denied' });
  });

  it('never opens the system permission prompt during background sync', async () => {
    await writeStoredReleaseNotifications({
      owner_id: user.id,
      enabled: true,
      unregister_secret: 'cd'.repeat(32),
      server_registered: false,
    });
    mockGetPermissions.mockResolvedValue(undetermined as never);

    const state = await syncReleaseNotifications(user.id);

    expect(mockRequestPermissions).not.toHaveBeenCalled();
    expect(mockGetExpoPushToken).not.toHaveBeenCalled();
    expect(state).toMatchObject({ enabled: true, pending: true, permission: 'undetermined' });
  });

  it('keeps a secure revocation queued until connectivity returns', async () => {
    await enableReleaseNotifications(user.id);
    mockRawRequest.mockRejectedValueOnce(new ApiError('Offline', 0));

    const state = await disableReleaseNotifications(user.id);

    expect(state.enabled).toBe(false);
    expect(await readPendingPushRevocations()).toEqual([
      {
        expo_push_token: expoToken,
        unregister_secret: 'ab'.repeat(32),
      },
    ]);

    mockRawRequest.mockResolvedValueOnce(undefined);
    await flushPendingPushRevocations();
    expect(await readPendingPushRevocations()).toEqual([]);
  });

  it('accepts only bounded release navigation payloads', () => {
    expect(
      releaseNotificationRoute({ kind: 'release', tmdb_id: 42, media_type: 'tv' }),
    ).toEqual({ pathname: '/media/[id]', params: { id: '42', type: 'tv' } });
    expect(
      releaseNotificationRoute({ kind: 'release', tmdb_id: '../../42', media_type: 'tv' }),
    ).toBeNull();
    expect(
      releaseNotificationRoute({ kind: 'release', tmdb_id: 42, media_type: 'person' }),
    ).toBeNull();
    expect(
      releaseNotificationRoute({
        kind: 'release',
        tmdb_id: 2_147_483_648,
        media_type: 'movie',
      }),
    ).toBeNull();
  });
});
