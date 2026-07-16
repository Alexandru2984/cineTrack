import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const REFRESH_TOKEN_KEY = 'vazute.refresh-token';
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
