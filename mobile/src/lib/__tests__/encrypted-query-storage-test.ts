import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

import { encryptedQueryStorage } from '@/lib/encrypted-query-storage';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(),
    setItem: jest.fn(),
    removeItem: jest.fn(),
  },
}));

jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked-this-device-only',
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

jest.mock('expo-crypto', () => ({
  ...(() => {
    class EncryptionKey {
      static async generate() {
        return new EncryptionKey();
      }

      static async import() {
        return new EncryptionKey();
      }

      async encoded() {
        return 'mock-device-key';
      }
    }

    class SealedData {
      readonly mockBytes: Uint8Array;

      constructor(value: Uint8Array) {
        this.mockBytes = value;
      }

      static fromCombined(value: string) {
        if (!value.startsWith('mock:')) throw new Error('invalid envelope');
        const values = value
          .slice(5)
          .split('.')
          .filter(Boolean)
          .map(Number);
        return new SealedData(Uint8Array.from(values));
      }

      async combined() {
        return `mock:${Array.from(this.mockBytes).join('.')}`;
      }
    }

    return {
      AESEncryptionKey: EncryptionKey,
      AESSealedData: SealedData,
      aesEncryptAsync: jest.fn(
        async (plaintext: Uint8Array) => new SealedData(plaintext),
      ),
      aesDecryptAsync: jest.fn(async (sealed: SealedData) => sealed.mockBytes),
    };
  })(),
}));

const mockGetItem = jest.mocked(AsyncStorage.getItem);
const mockSetItem = jest.mocked(AsyncStorage.setItem);
const mockRemoveItem = jest.mocked(AsyncStorage.removeItem);
const mockGetSecureItem = jest.mocked(SecureStore.getItemAsync);
const mockSetSecureItem = jest.mocked(SecureStore.setItemAsync);
let storedValue: string | null;

describe('encrypted query storage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    storedValue = null;
    mockGetItem.mockImplementation(async () => storedValue);
    mockSetItem.mockImplementation(async (_key, value) => {
      storedValue = value;
    });
    mockRemoveItem.mockImplementation(async () => {
      storedValue = null;
    });
    mockGetSecureItem.mockResolvedValue(null);
    mockSetSecureItem.mockResolvedValue();
  });

  it('never writes query JSON to AsyncStorage in plaintext', async () => {
    const value = JSON.stringify({ title: 'Private watch history' });

    await encryptedQueryStorage.setItem('vazute.query-cache', value);

    expect(storedValue).toMatch(/^v1:mock:/);
    expect(storedValue).not.toContain('Private watch history');
    await expect(encryptedQueryStorage.getItem('vazute.query-cache')).resolves.toBe(value);
    expect(mockSetSecureItem).toHaveBeenCalledWith(
      'vazute.query-cache-key.v1',
      'mock-device-key',
      expect.objectContaining({
        keychainAccessible: 'when-unlocked-this-device-only',
      }),
    );
  });

  it('removes legacy plaintext and corrupted encrypted cache entries', async () => {
    storedValue = JSON.stringify({ history: 'legacy plaintext' });
    await expect(encryptedQueryStorage.getItem('vazute.query-cache')).resolves.toBeNull();
    expect(storedValue).toBeNull();

    storedValue = 'v1:corrupted';
    await expect(encryptedQueryStorage.getItem('vazute.query-cache')).resolves.toBeNull();
    expect(storedValue).toBeNull();
    expect(mockRemoveItem).toHaveBeenCalledTimes(2);
  });
});
