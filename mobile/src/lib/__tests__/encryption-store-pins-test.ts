import { loadPin, savePin } from '@/lib/crypto/pins';
import { pinFor } from '@/lib/crypto/trust';
import { useEncryptionStore } from '@/store/encryption';

const mockStore = new Map<string, string>();

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async (key: string) => mockStore.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => {
      mockStore.set(key, value);
    }),
    removeItem: jest.fn(async (key: string) => {
      mockStore.delete(key);
    }),
  },
}));

jest.mock('expo-secure-store', () => ({
  deleteItemAsync: jest.fn(async () => undefined),
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  isAvailableAsync: jest.fn(async () => true),
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 0,
}));

// `pins.ts` can forget, but that is worth nothing unless the action a person
// takes to forget an account on this device actually calls it.
describe('forgetting an account on this phone', () => {
  beforeEach(() => mockStore.clear());

  it('takes its contact pins with its keys', async () => {
    await savePin('me-id', 'alice-id', pinFor('a'.repeat(64), 'alice'));
    await useEncryptionStore.getState().clear('me-id');
    expect(await loadPin('me-id', 'alice-id')).toBeNull();
  });

  it('leaves pins alone when no account is being forgotten', async () => {
    await savePin('me-id', 'alice-id', pinFor('a'.repeat(64), 'alice'));
    await useEncryptionStore.getState().clear(null);
    expect(await loadPin('me-id', 'alice-id')).not.toBeNull();
  });
});
