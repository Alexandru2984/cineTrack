import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const REFRESH_TOKEN_KEY = 'vazute.refresh-token';
const CACHED_SESSION_KEY = 'vazute.cached-session';
const LOGOUT_REVOCATIONS_KEY = 'vazute.logout-revocations.v1';
const MAX_LOGOUT_REVOCATIONS = 5;
const REFRESH_TOKEN_PATTERN = /^[a-f0-9]{128}$/;
const secureOptions: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export async function readRefreshToken() {
  if (Platform.OS === 'web') return null;
  return SecureStore.getItemAsync(REFRESH_TOKEN_KEY, secureOptions);
}

export async function writeRefreshToken(token: string) {
  if (Platform.OS === 'web') return;
  await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, token, secureOptions);
}

export async function removeRefreshToken() {
  if (Platform.OS === 'web') return;
  await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY, secureOptions);
}

export async function readCachedSession(): Promise<unknown | null> {
  if (Platform.OS === 'web') return null;
  const value = await SecureStore.getItemAsync(CACHED_SESSION_KEY, secureOptions);
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    await SecureStore.deleteItemAsync(CACHED_SESSION_KEY, secureOptions);
    return null;
  }
}

export async function writeCachedSession(refreshToken: string, user: unknown) {
  if (Platform.OS === 'web') return;
  await SecureStore.setItemAsync(
    CACHED_SESSION_KEY,
    JSON.stringify({ refresh_token: refreshToken, user }),
    secureOptions,
  );
}

export async function removeCachedSession() {
  if (Platform.OS === 'web') return;
  await SecureStore.deleteItemAsync(CACHED_SESSION_KEY, secureOptions);
}

async function writeLogoutRevocations(tokens: string[]) {
  if (Platform.OS === 'web') return;
  const bounded = Array.from(
    new Set(tokens.filter((token) => REFRESH_TOKEN_PATTERN.test(token))),
  ).slice(-MAX_LOGOUT_REVOCATIONS);
  if (bounded.length === 0) {
    await SecureStore.deleteItemAsync(LOGOUT_REVOCATIONS_KEY, secureOptions);
    return;
  }
  await SecureStore.setItemAsync(
    LOGOUT_REVOCATIONS_KEY,
    JSON.stringify(bounded),
    secureOptions,
  );
}

export async function readPendingLogoutRevocations() {
  if (Platform.OS === 'web') return [];
  const value = await SecureStore.getItemAsync(LOGOUT_REVOCATIONS_KEY, secureOptions);
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .filter((token): token is string =>
          typeof token === 'string' && REFRESH_TOKEN_PATTERN.test(token),
        )
        .slice(-MAX_LOGOUT_REVOCATIONS);
    }
  } catch {
    // Invalid local state is removed below.
  }
  await SecureStore.deleteItemAsync(LOGOUT_REVOCATIONS_KEY, secureOptions);
  return [];
}

export async function queueLogoutRevocation(token: string) {
  if (!REFRESH_TOKEN_PATTERN.test(token)) return;
  const existing = await readPendingLogoutRevocations();
  await writeLogoutRevocations([...existing, token]);
}

export async function removePendingLogoutRevocation(token: string) {
  const existing = await readPendingLogoutRevocations();
  await writeLogoutRevocations(existing.filter((candidate) => candidate !== token));
}
