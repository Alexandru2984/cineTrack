import { forgetPins, loadPin, savePin } from '@/lib/crypto/pins';
import { pinFor } from '@/lib/crypto/trust';

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

const A = 'a'.repeat(64);

describe('peer pins on the phone', () => {
  beforeEach(() => mockStore.clear());

  it('remembers a pin per contact', async () => {
    await savePin('me-id', 'alice-id', pinFor(A, 'alice'));
    expect((await loadPin('me-id', 'alice-id'))?.fingerprint).toBe(A);
    expect(await loadPin('me-id', 'bob-id')).toBeNull();
  });

  it('keeps two accounts on one phone apart', async () => {
    await savePin('me-id', 'alice-id', pinFor(A, 'alice'));
    expect(await loadPin('someone-else', 'alice-id')).toBeNull();
  });

  it('forgets every pin of an account, and only that account', async () => {
    await savePin('me-id', 'alice-id', pinFor(A, 'alice'));
    await savePin('someone-else', 'alice-id', pinFor(A, 'alice'));
    await forgetPins('me-id');
    expect(await loadPin('me-id', 'alice-id')).toBeNull();
    expect(await loadPin('someone-else', 'alice-id')).not.toBeNull();
  });

  it('reads a corrupted store as empty rather than throwing', async () => {
    mockStore.set('vazute.e2ee.pins.me-id', '{not json');
    expect(await loadPin('me-id', 'alice-id')).toBeNull();
  });
});
