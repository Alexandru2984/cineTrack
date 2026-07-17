import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const REFRESH_TOKEN_KEY = 'vazute.refresh-token';
const CACHED_SESSION_KEY = 'vazute.cached-session';
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
