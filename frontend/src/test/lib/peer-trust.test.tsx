import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { usePeerTrust } from '@/hooks/usePeerTrust';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const alice = (fingerprint: string) => ({ userId: 'alice-id', username: 'alice', fingerprint });

describe('usePeerTrust', () => {
  beforeEach(() => localStorage.clear());

  it('is silent on first contact and remembers the key', async () => {
    const first = renderHook(() => usePeerTrust('me-id', alice(A)));
    await waitFor(() => expect(first.result.current.trust).toBe('first-contact'));
    const again = renderHook(() => usePeerTrust('me-id', alice(A)));
    await waitFor(() => expect(again.result.current.trust).toBe('unchanged'));
  });

  it('reports a changed key, and keeps reporting it until the member accepts it', async () => {
    const first = renderHook(() => usePeerTrust('me-id', alice(A)));
    await waitFor(() => expect(first.result.current.trust).toBe('first-contact'));

    const changed = renderHook(() => usePeerTrust('me-id', alice(B)));
    await waitFor(() => expect(changed.result.current.trust).toBe('changed'));
    changed.unmount();

    // A reload must not quietly accept the new key: a warning that clears
    // itself is one an attacker only has to wait out.
    const reload = renderHook(() => usePeerTrust('me-id', alice(B)));
    await waitFor(() => expect(reload.result.current.trust).toBe('changed'));

    await act(async () => {
      await reload.result.current.accept();
    });
    expect(reload.result.current.trust).toBe('unchanged');

    const after = renderHook(() => usePeerTrust('me-id', alice(B)));
    await waitFor(() => expect(after.result.current.trust).toBe('unchanged'));
  });

  it('keeps pins per account', async () => {
    const mine = renderHook(() => usePeerTrust('me-id', alice(A)));
    await waitFor(() => expect(mine.result.current.trust).toBe('first-contact'));
    const theirs = renderHook(() => usePeerTrust('someone-else', alice(B)));
    await waitFor(() => expect(theirs.result.current.trust).toBe('first-contact'));
  });

  it('has nothing to say without a contact to check', () => {
    const none = renderHook(() => usePeerTrust('me-id', null));
    expect(none.result.current.trust).toBeNull();
  });
});
