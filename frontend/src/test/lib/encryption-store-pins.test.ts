import { beforeEach, describe, expect, it } from 'vitest';

import { loadPin, savePin } from '@/lib/crypto/pins';
import { pinFor } from '@/lib/crypto/trust';
import { useEncryptionStore } from '@/store/encryption';

// `pins.ts` can forget, but that is worth nothing unless the action a person
// takes to forget an account on this device actually calls it. A shared
// browser would otherwise keep the list of who they had been writing to.
describe('forgetting an account on this browser', () => {
  beforeEach(() => localStorage.clear());

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
