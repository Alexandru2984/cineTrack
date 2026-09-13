import { act, renderHook, waitFor } from '@testing-library/react-native';

import { usePeerTrust } from '@/hooks/use-peer-trust';

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
const B = 'b'.repeat(64);
const alice = (fingerprint: string) => ({ userId: 'alice-id', username: 'alice', fingerprint });

describe('usePeerTrust', () => {
  beforeEach(() => mockStore.clear());

  it('is silent on first contact and remembers the key', async () => {
    const first = await renderHook(() => usePeerTrust('me-id', alice(A)));
    await waitFor(() => expect(first.result.current.trust).toBe('first-contact'));
    const again = await renderHook(() => usePeerTrust('me-id', alice(A)));
    await waitFor(() => expect(again.result.current.trust).toBe('unchanged'));
  });

  it('reports a changed key, and keeps reporting it until the member accepts it', async () => {
    const first = await renderHook(() => usePeerTrust('me-id', alice(A)));
    await waitFor(() => expect(first.result.current.trust).toBe('first-contact'));

    const changed = await renderHook(() => usePeerTrust('me-id', alice(B)));
    await waitFor(() => expect(changed.result.current.trust).toBe('changed'));
    // Awaited: unmounting is asynchronous in this version of testing-library,
    // and an un-awaited one overlaps the next act() — which is what made this
    // test fail against correct code the first time it was written.
    await changed.unmount();

    // A second load, before anybody accepts anything, must still warn. A
    // warning that clears itself on the next load is one an attacker only has
    // to wait out — and this assertion was missing here while the web client's
    // had it, which let a mutant that re-pins on change pass on this platform.
    const reload = await renderHook(() => usePeerTrust('me-id', alice(B)));
    await waitFor(() => expect(reload.result.current.trust).toBe('changed'));

    await act(async () => {
      await reload.result.current.accept();
    });
    expect(reload.result.current.trust).toBe('unchanged');

    const after = await renderHook(() => usePeerTrust('me-id', alice(B)));
    await waitFor(() => expect(after.result.current.trust).toBe('unchanged'));
  });

  it('has nothing to say without a contact to check', async () => {
    const none = await renderHook(() => usePeerTrust('me-id', null));
    expect(none.result.current.trust).toBeNull();
  });
});
