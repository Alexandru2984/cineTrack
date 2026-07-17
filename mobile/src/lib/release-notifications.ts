import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { apiRequest } from '@/lib/api';
import { ApiError, rawRequest } from '@/lib/http';
import {
  detachStoredReleaseNotifications,
  queuePushRevocation,
  readPendingPushRevocations,
  readStoredReleaseNotifications,
  removePendingPushRevocation,
  writeStoredReleaseNotifications,
  type StoredReleaseNotificationPreference,
} from '@/lib/secure-release-notifications';
import { useAuthStore } from '@/store/auth';

const RELEASE_CHANNEL_ID = 'releases';
const MAX_TMDB_ID = 2_147_483_647;
const EXPO_TOKEN_PATTERN = /^Expo(?:nent)?PushToken\[[A-Za-z0-9_-]{10,200}\]$/;

type NativePushPlatform = 'android' | 'ios';
export type ReleaseNotificationPermission =
  | 'granted'
  | 'denied'
  | 'undetermined'
  | 'unavailable'
  | 'unsupported';

export interface ReleaseNotificationState {
  enabled: boolean;
  pending: boolean;
  permission: ReleaseNotificationPermission;
  canAskAgain: boolean;
}

export interface ReleaseNotificationRoute {
  pathname: '/media/[id]';
  params: { id: string; type: 'movie' | 'tv' };
}

interface PermissionSnapshot {
  permission: ReleaseNotificationPermission;
  canAskAgain: boolean;
}

let operationTail: Promise<void> = Promise.resolve();
let syncInFlight: { ownerId: string; promise: Promise<ReleaseNotificationState> } | null = null;
let foregroundHandlerInstalled = false;

function withOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = operationTail.then(operation, operation);
  operationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function nativePlatform(): NativePushPlatform | null {
  return Platform.OS === 'android' || Platform.OS === 'ios' ? Platform.OS : null;
}

function appVersion() {
  const configured = Constants.expoConfig?.version?.trim();
  return configured && /^[A-Za-z0-9._+-]{1,32}$/.test(configured)
    ? configured
    : 'unknown';
}

function projectId() {
  const easProjectId = Constants.easConfig?.projectId;
  const extra = Constants.expoConfig?.extra as
    | { eas?: { projectId?: unknown } }
    | undefined;
  const configured = easProjectId ?? extra?.eas?.projectId;
  return typeof configured === 'string' && configured.trim()
    ? configured.trim()
    : null;
}

function utcOffsetMinutes() {
  return Math.max(-840, Math.min(840, -new Date().getTimezoneOffset()));
}

async function generateUnregisterSecret() {
  const bytes = await Crypto.getRandomBytesAsync(32);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function permissionSnapshot(
  status: { status: string; canAskAgain: boolean },
): PermissionSnapshot {
  if (status.status === 'granted') {
    return { permission: 'granted', canAskAgain: status.canAskAgain };
  }
  if (status.status === 'denied') {
    return { permission: 'denied', canAskAgain: status.canAskAgain };
  }
  return { permission: 'undetermined', canAskAgain: status.canAskAgain };
}

async function readPermission(): Promise<PermissionSnapshot> {
  if (!nativePlatform()) {
    return { permission: 'unsupported', canAskAgain: false };
  }
  try {
    return permissionSnapshot(await Notifications.getPermissionsAsync());
  } catch {
    return { permission: 'unavailable', canAskAgain: false };
  }
}

async function configureReleaseChannel() {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(RELEASE_CHANNEL_ID, {
    name: 'Release alerts',
    description: 'New episodes and planned movie releases',
    importance: Notifications.AndroidImportance.DEFAULT,
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
    sound: 'default',
    enableVibrate: false,
    showBadge: false,
  });
}

function isCurrentAuthenticatedUser(ownerId: string) {
  const auth = useAuthStore.getState();
  return auth.status === 'authenticated' && auth.user?.id === ownerId;
}

async function stateUnlocked(ownerId: string): Promise<ReleaseNotificationState> {
  const [stored, permission] = await Promise.all([
    readStoredReleaseNotifications(),
    readPermission(),
  ]);
  const preference = stored?.owner_id === ownerId ? stored : null;
  return {
    enabled: preference?.enabled === true,
    pending: preference?.enabled === true && !preference.server_registered,
    ...permission,
  };
}

function shouldRetainRevocation(error: unknown) {
  return (
    !(error instanceof ApiError) ||
    error.status === 0 ||
    error.status === 429 ||
    error.status >= 500
  );
}

async function flushRevocationsUnlocked() {
  const pending = await readPendingPushRevocations();
  for (const revocation of pending) {
    try {
      await rawRequest('/push/devices/revoke', {
        method: 'POST',
        body: revocation,
      });
      await removePendingPushRevocation(revocation.expo_push_token);
    } catch (error) {
      if (shouldRetainRevocation(error)) break;
      await removePendingPushRevocation(revocation.expo_push_token);
    }
  }
}

async function syncUnlocked(ownerId: string): Promise<ReleaseNotificationState> {
  await flushRevocationsUnlocked();
  let preference = await readStoredReleaseNotifications();
  if (!preference) return stateUnlocked(ownerId);
  if (preference.owner_id !== ownerId) {
    await detachStoredReleaseNotifications();
    await flushRevocationsUnlocked();
    return stateUnlocked(ownerId);
  }
  if (!isCurrentAuthenticatedUser(ownerId)) return stateUnlocked(ownerId);

  await configureReleaseChannel();
  const permission = await readPermission();
  if (permission.permission !== 'granted') {
    if (permission.permission === 'denied') {
      await detachStoredReleaseNotifications(ownerId);
      await flushRevocationsUnlocked();
    }
    return stateUnlocked(ownerId);
  }

  const expoProjectId = projectId();
  if (!expoProjectId) {
    throw new Error('Push notification project configuration is missing');
  }
  const token = (await Notifications.getExpoPushTokenAsync({
    projectId: expoProjectId,
  })).data;
  if (!EXPO_TOKEN_PATTERN.test(token)) {
    throw new Error('The notification service returned an invalid device token');
  }
  if (!isCurrentAuthenticatedUser(ownerId)) {
    await detachStoredReleaseNotifications(ownerId);
    return stateUnlocked(ownerId);
  }

  preference = await readStoredReleaseNotifications();
  if (!preference || preference.owner_id !== ownerId) return stateUnlocked(ownerId);
  if (preference.expo_push_token && preference.expo_push_token !== token) {
    await queuePushRevocation({
      expo_push_token: preference.expo_push_token,
      unregister_secret: preference.unregister_secret,
    });
  }
  const pendingPreference: StoredReleaseNotificationPreference = {
    ...preference,
    expo_push_token: token,
    server_registered: false,
  };
  await writeStoredReleaseNotifications(pendingPreference);
  await flushRevocationsUnlocked();

  await apiRequest('/push/devices', {
    method: 'PUT',
    body: {
      expo_push_token: token,
      unregister_secret: pendingPreference.unregister_secret,
      platform: nativePlatform(),
      app_version: appVersion(),
      utc_offset_minutes: utcOffsetMinutes(),
    },
  });

  if (!isCurrentAuthenticatedUser(ownerId)) {
    await detachStoredReleaseNotifications(ownerId);
    await flushRevocationsUnlocked();
    return stateUnlocked(ownerId);
  }
  const latest = await readStoredReleaseNotifications();
  if (
    latest?.owner_id === ownerId &&
    latest.expo_push_token === token &&
    latest.unregister_secret === pendingPreference.unregister_secret
  ) {
    await writeStoredReleaseNotifications({ ...latest, server_registered: true });
  }
  return stateUnlocked(ownerId);
}

export function installReleaseNotificationHandler() {
  if (foregroundHandlerInstalled || !nativePlatform()) return;
  try {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
      }),
    });
    foregroundHandlerInstalled = true;
  } catch {
    // A native rebuild is required before an older development client can use this module.
  }
}

export function releaseNotificationRoute(
  data: Record<string, unknown> | null | undefined,
): ReleaseNotificationRoute | null {
  if (!data || data.kind !== 'release') return null;
  if (data.media_type !== 'movie' && data.media_type !== 'tv') return null;
  if (
    typeof data.tmdb_id !== 'number' ||
    !Number.isSafeInteger(data.tmdb_id) ||
    data.tmdb_id <= 0 ||
    data.tmdb_id > MAX_TMDB_ID
  ) {
    return null;
  }
  return {
    pathname: '/media/[id]',
    params: { id: String(data.tmdb_id), type: data.media_type },
  };
}

export function installReleaseNotificationResponseHandler(
  onRoute: (route: ReleaseNotificationRoute) => void,
) {
  const handle = (response: Notifications.NotificationResponse) => {
    if (response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    const route = releaseNotificationRoute(response.notification.request.content.data);
    if (route) onRoute(route);
  };

  try {
    const lastResponse = Notifications.getLastNotificationResponse();
    if (lastResponse) {
      Notifications.clearLastNotificationResponse();
      handle(lastResponse);
    }
    const subscription = Notifications.addNotificationResponseReceivedListener(handle);
    return () => subscription.remove();
  } catch {
    return () => undefined;
  }
}

export function getReleaseNotificationState(ownerId: string) {
  return withOperation(() => stateUnlocked(ownerId));
}

export function enableReleaseNotifications(ownerId: string) {
  return withOperation(async () => {
    if (!nativePlatform()) return stateUnlocked(ownerId);
    await configureReleaseChannel();
    let permission = await readPermission();
    if (permission.permission !== 'granted' && permission.canAskAgain) {
      permission = permissionSnapshot(
        await Notifications.requestPermissionsAsync({
          android: {},
          ios: { allowAlert: true, allowBadge: false, allowSound: true },
        }),
      );
    }
    if (permission.permission !== 'granted') {
      await detachStoredReleaseNotifications(ownerId);
      await flushRevocationsUnlocked();
      return stateUnlocked(ownerId);
    }

    let preference = await readStoredReleaseNotifications();
    if (preference && preference.owner_id !== ownerId) {
      await detachStoredReleaseNotifications();
      await flushRevocationsUnlocked();
      preference = null;
    }
    if (!preference) {
      preference = {
        owner_id: ownerId,
        enabled: true,
        unregister_secret: await generateUnregisterSecret(),
        server_registered: false,
      };
      await writeStoredReleaseNotifications(preference);
    }
    return syncUnlocked(ownerId);
  });
}

export function disableReleaseNotifications(ownerId: string) {
  return withOperation(async () => {
    await detachStoredReleaseNotifications(ownerId);
    await flushRevocationsUnlocked();
    return stateUnlocked(ownerId);
  });
}

export function flushPendingPushRevocations() {
  return withOperation(flushRevocationsUnlocked);
}

export function syncReleaseNotifications(ownerId: string) {
  if (syncInFlight?.ownerId === ownerId) return syncInFlight.promise;
  const promise = withOperation(() => syncUnlocked(ownerId));
  syncInFlight = { ownerId, promise };
  const clearInFlight = () => {
    if (syncInFlight?.promise === promise) syncInFlight = null;
  };
  void promise.then(clearInFlight, clearInFlight);
  return promise;
}
