import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  AESEncryptionKey,
  AESSealedData,
  aesDecryptAsync,
  aesEncryptAsync,
} from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

const ENCRYPTION_KEY = 'vazute.query-cache-key.v1';
const ENVELOPE_PREFIX = 'v1:';
const secureOptions: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

let encryptionKeyPromise: Promise<AESEncryptionKey> | null = null;

async function loadEncryptionKey() {
  const encoded = await SecureStore.getItemAsync(ENCRYPTION_KEY, secureOptions);
  if (encoded) {
    try {
      return (await AESEncryptionKey.import(encoded, 'base64')) as AESEncryptionKey;
    } catch {
      await SecureStore.deleteItemAsync(ENCRYPTION_KEY, secureOptions).catch(
        () => undefined,
      );
    }
  }

  const generated = (await AESEncryptionKey.generate()) as AESEncryptionKey;
  await SecureStore.setItemAsync(
    ENCRYPTION_KEY,
    await generated.encoded('base64'),
    secureOptions,
  );
  return generated;
}

function getEncryptionKey() {
  encryptionKeyPromise ??= loadEncryptionKey().catch((error) => {
    encryptionKeyPromise = null;
    throw error;
  });
  return encryptionKeyPromise;
}

function additionalData(storageKey: string) {
  return new TextEncoder().encode(`vazute-query-cache:${storageKey}`);
}

export const encryptedQueryStorage = {
  async getItem(storageKey: string) {
    const envelope = await AsyncStorage.getItem(storageKey);
    if (!envelope) return null;
    if (!envelope.startsWith(ENVELOPE_PREFIX)) {
      await AsyncStorage.removeItem(storageKey).catch(() => undefined);
      return null;
    }

    try {
      const key = await getEncryptionKey();
      const sealed = AESSealedData.fromCombined(
        envelope.slice(ENVELOPE_PREFIX.length),
      );
      const plaintext = await aesDecryptAsync(sealed, key, {
        additionalData: additionalData(storageKey),
      });
      return new TextDecoder().decode(plaintext);
    } catch {
      await AsyncStorage.removeItem(storageKey).catch(() => undefined);
      return null;
    }
  },

  async setItem(storageKey: string, value: string) {
    const key = await getEncryptionKey();
    const sealed = await aesEncryptAsync(new TextEncoder().encode(value), key, {
      additionalData: additionalData(storageKey),
    });
    const combined = await sealed.combined('base64');
    await AsyncStorage.setItem(storageKey, `${ENVELOPE_PREFIX}${combined}`);
  },

  removeItem(storageKey: string) {
    return AsyncStorage.removeItem(storageKey);
  },
};
