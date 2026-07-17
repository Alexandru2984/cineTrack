import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { z } from 'zod';

const PREFERENCE_KEY = 'vazute.release-notifications.v1';
const REVOCATIONS_KEY = 'vazute.push-revocations.v1';
const MAX_PENDING_REVOCATIONS = 5;
const expoPushTokenSchema = z.string().regex(
  /^Expo(?:nent)?PushToken\[[A-Za-z0-9_-]{10,200}\]$/,
);
const unregisterSecretSchema = z.string().regex(/^[a-f0-9]{64}$/);
const secureOptions: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

const preferenceSchema = z.object({
  owner_id: z.string().uuid(),
  enabled: z.literal(true),
  unregister_secret: unregisterSecretSchema,
  expo_push_token: expoPushTokenSchema.optional(),
  server_registered: z.boolean(),
}).strict();

const revocationSchema = z.object({
  expo_push_token: expoPushTokenSchema,
  unregister_secret: unregisterSecretSchema,
}).strict();

export type StoredReleaseNotificationPreference = z.infer<typeof preferenceSchema>;
export type PendingPushRevocation = z.infer<typeof revocationSchema>;

let storageTail: Promise<void> = Promise.resolve();

function withStorageLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = storageTail.then(operation, operation);
  storageTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function readPreferenceUnlocked() {
  if (Platform.OS === 'web') return null;
  const value = await SecureStore.getItemAsync(PREFERENCE_KEY, secureOptions);
  if (!value) return null;
  try {
    const parsed = preferenceSchema.safeParse(JSON.parse(value) as unknown);
    if (parsed.success) return parsed.data;
  } catch {
    // Invalid local state is removed below.
  }
  await SecureStore.deleteItemAsync(PREFERENCE_KEY, secureOptions);
  return null;
}

async function writePreferenceUnlocked(
  preference: StoredReleaseNotificationPreference | null,
) {
  if (Platform.OS === 'web') return;
  if (!preference) {
    await SecureStore.deleteItemAsync(PREFERENCE_KEY, secureOptions);
    return;
  }
  const validated = preferenceSchema.parse(preference);
  await SecureStore.setItemAsync(
    PREFERENCE_KEY,
    JSON.stringify(validated),
    secureOptions,
  );
}

async function readRevocationsUnlocked() {
  if (Platform.OS === 'web') return [];
  const value = await SecureStore.getItemAsync(REVOCATIONS_KEY, secureOptions);
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .flatMap((entry) => {
          const result = revocationSchema.safeParse(entry);
          return result.success ? [result.data] : [];
        })
        .slice(-MAX_PENDING_REVOCATIONS);
    }
  } catch {
    // Invalid local state is removed below.
  }
  await SecureStore.deleteItemAsync(REVOCATIONS_KEY, secureOptions);
  return [];
}

async function writeRevocationsUnlocked(revocations: PendingPushRevocation[]) {
  if (Platform.OS === 'web') return;
  if (revocations.length === 0) {
    await SecureStore.deleteItemAsync(REVOCATIONS_KEY, secureOptions);
    return;
  }
  const bounded = revocations
    .map((entry) => revocationSchema.parse(entry))
    .slice(-MAX_PENDING_REVOCATIONS);
  await SecureStore.setItemAsync(
    REVOCATIONS_KEY,
    JSON.stringify(bounded),
    secureOptions,
  );
}

async function queueRevocationUnlocked(revocation: PendingPushRevocation) {
  const validated = revocationSchema.parse(revocation);
  const existing = await readRevocationsUnlocked();
  await writeRevocationsUnlocked([
    ...existing.filter((entry) => entry.expo_push_token !== validated.expo_push_token),
    validated,
  ]);
}

export function readStoredReleaseNotifications() {
  return withStorageLock(readPreferenceUnlocked);
}

export function writeStoredReleaseNotifications(
  preference: StoredReleaseNotificationPreference | null,
) {
  return withStorageLock(() => writePreferenceUnlocked(preference));
}

export function readPendingPushRevocations() {
  return withStorageLock(readRevocationsUnlocked);
}

export function queuePushRevocation(revocation: PendingPushRevocation) {
  return withStorageLock(() => queueRevocationUnlocked(revocation));
}

export function removePendingPushRevocation(expoPushToken: string) {
  return withStorageLock(async () => {
    const existing = await readRevocationsUnlocked();
    await writeRevocationsUnlocked(
      existing.filter((entry) => entry.expo_push_token !== expoPushToken),
    );
  });
}

export function detachStoredReleaseNotifications(ownerId?: string) {
  return withStorageLock(async () => {
    const preference = await readPreferenceUnlocked();
    if (!preference || (ownerId && preference.owner_id !== ownerId)) return false;
    if (preference.expo_push_token) {
      await queueRevocationUnlocked({
        expo_push_token: preference.expo_push_token,
        unregister_secret: preference.unregister_secret,
      });
    }
    await writePreferenceUnlocked(null);
    return true;
  });
}
