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

// Refresh token for a session the user chose NOT to keep signed in ("keep me
// logged in" unchecked). It lives only for the life of the app process, so a
// cold start finds nothing in the keychain and the next visit signs in fresh,
// while refreshes during this run still work.
let volatileRefreshToken: string | null = null;

export async function readRefreshToken() {
  if (Platform.OS === 'web') return null;
  if (volatileRefreshToken !== null) return volatileRefreshToken;
  return SecureStore.getItemAsync(REFRESH_TOKEN_KEY, secureOptions);
}

export async function writeRefreshToken(token: string, persist = true) {
  if (Platform.OS === 'web') return;
  if (persist) {
    volatileRefreshToken = null;
    await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, token, secureOptions);
  } else {
    // Session-only: hold it in memory and make sure no copy lingers on disk.
    volatileRefreshToken = token;
    await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY, secureOptions);
  }
}

export async function removeRefreshToken() {
  if (Platform.OS === 'web') return;
  volatileRefreshToken = null;
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

export async function writeCachedSession(refreshToken: string, user: unknown, persist = true) {
  if (Platform.OS === 'web') return;
  // The cached session is the offline fallback for a persistent login. A
  // session-only login must leave nothing on disk, so it clears the cache instead.
  if (!persist) {
    await removeCachedSession().catch(() => undefined);
    return;
  }
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
