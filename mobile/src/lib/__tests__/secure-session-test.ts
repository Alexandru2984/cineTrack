import * as SecureStore from 'expo-secure-store';

import {
  queueLogoutRevocation,
  readPendingLogoutRevocations,
  removePendingLogoutRevocation,
} from '@/lib/secure-session';

jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked-this-device-only',
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

const mockGetItem = jest.mocked(SecureStore.getItemAsync);
const mockSetItem = jest.mocked(SecureStore.setItemAsync);
const mockDeleteItem = jest.mocked(SecureStore.deleteItemAsync);

describe('secure logout revocation queue', () => {
  let values: Map<string, string>;

  beforeEach(() => {
    jest.clearAllMocks();
    values = new Map();
    mockGetItem.mockImplementation(async (key) => values.get(key) ?? null);
    mockSetItem.mockImplementation(async (key, value) => {
      values.set(key, value);
    });
    mockDeleteItem.mockImplementation(async (key) => {
      values.delete(key);
    });
  });

  it('deduplicates and bounds queued refresh tokens', async () => {
    const tokens = Array.from({ length: 6 }, (_, index) =>
      index.toString(16).padStart(128, '0'),
    );
    for (const token of [...tokens, tokens[5]]) {
      await queueLogoutRevocation(token);
    }

    await expect(readPendingLogoutRevocations()).resolves.toEqual(tokens.slice(1));
  });

  it('removes delivered revocations and ignores malformed tokens', async () => {
    const token = 'a'.repeat(128);
    await queueLogoutRevocation('not-a-refresh-token');
    await queueLogoutRevocation(token);
    await removePendingLogoutRevocation(token);

    await expect(readPendingLogoutRevocations()).resolves.toEqual([]);
    expect(mockDeleteItem).toHaveBeenCalled();
  });
});
