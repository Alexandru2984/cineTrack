import { describe, expect, it } from 'vitest';

import { comparePeerKeys, isPeerPin, pinFor } from '@/lib/crypto/trust';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

describe('peer key trust', () => {
  it('says nothing on first contact, because there is no earlier key to compare', () => {
    expect(comparePeerKeys(null, A)).toBe('first-contact');
  });

  it('recognises the key it pinned', () => {
    expect(comparePeerKeys(pinFor(A, 'alice'), A)).toBe('unchanged');
  });

  it('reports a different key rather than quietly accepting it', () => {
    expect(comparePeerKeys(pinFor(A, 'alice'), B)).toBe('changed');
  });

  it('cannot miss a match on case alone', () => {
    // A pin stored upper-cased would fail `isPeerPin`, read as first contact
    // forever, and never warn. `pinFor` lower-cases so that cannot happen.
    expect(comparePeerKeys(pinFor(A.toUpperCase(), 'alice'), A)).toBe('unchanged');
    expect(comparePeerKeys(pinFor(A, 'alice'), A.toUpperCase())).toBe('unchanged');
  });

  it('treats an unreadable pin as none, never as a change', () => {
    expect(comparePeerKeys({ fingerprint: 'not-hex' }, A)).toBe('first-contact');
    expect(comparePeerKeys('garbage', A)).toBe('first-contact');
    expect(isPeerPin({ fingerprint: A.toUpperCase(), username: 'x', pinnedAt: 'y' })).toBe(false);
  });
});
