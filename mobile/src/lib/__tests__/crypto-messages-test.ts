import { fingerprint, fromHex, generateIdentity, toHex } from '@/lib/crypto/core';
import {
  clearDecryptionCache,
  readConversationPreview,
  readMessage,
  sealMessage,
} from '@/lib/crypto/messages';
import type { DirectMessage, MessageConversation, PeerPublicKeys } from '@/types';

/** A well-formed client nonce, generated rather than pasted.
 *
 *  These tests need *a* nonce, not a particular one. A UUID literal sitting
 *  beside a name like this is indistinguishable from a leaked credential to a
 *  secret scanner, and a false positive that has to be explained away every
 *  time is worse than one line of setup. */
function clientNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const CLIENT_NONCE = clientNonce();

/** The accounts in these conversations. Signatures name them, so they have to
 *  be real UUIDs; generated for the same reason as the nonce. */
const ALICE_ID = clientNonce();
const BOB_ID = clientNonce();
const CAROL_ID = clientNonce();

/** Bob's conversation with Alice, as Bob's device knows it. */
const BOB_THREAD = { selfId: BOB_ID, peerId: ALICE_ID };

function peerFrom(
  identity: ReturnType<typeof generateIdentity>,
  userId: string = BOB_ID,
): PeerPublicKeys {
  return {
    user_id: userId,
    username: 'peer',
    exchange_public_key: toHex(identity.exchangePublicKey),
    signing_public_key: toHex(identity.signingPublicKey),
    // Computed from the keys beside it rather than a row of 'f's. A directory
    // entry whose stated fingerprint does not match its own keys is one the
    // client now refuses to encrypt to, so a placeholder here would be a
    // fixture describing a state that cannot exist.
    key_fingerprint: fingerprint(identity.exchangePublicKey, identity.signingPublicKey),
    generation: 1,
    updated_at: new Date().toISOString(),
  };
}

function messageFrom(
  sealed: ReturnType<typeof sealMessage>,
  id = 'message-1',
  extra: Partial<DirectMessage> = {},
): DirectMessage {
  return {
    id,
    sender_id: ALICE_ID,
    recipient_id: BOB_ID,
    body: null,
    ciphertext: sealed.ciphertext,
    nonce: sealed.nonce,
    sender_ephemeral_key: sealed.sender_ephemeral_key,
    sender_copy: sealed.sender_copy,
    franking_commitment: sealed.franking_commitment,
    franking_signature: sealed.franking_signature,
    client_nonce: CLIENT_NONCE,
    read_at: null,
    created_at: new Date().toISOString(),
    ...extra,
  };
}

describe('reading messages', () => {
  it('passes a plaintext message through untouched', () => {
    const message = {
      id: 'plain-1',
      sender_id: 'alice',
      recipient_id: 'bob',
      body: 'nothing to decrypt here',
      read_at: null,
      created_at: new Date().toISOString(),
    } satisfies DirectMessage;

    expect(readMessage(message, null)).toEqual({ kind: 'plain', text: 'nothing to decrypt here' });
  });

  it('opens an encrypted message for both the recipient and the sender', () => {
    clearDecryptionCache();
    const alice = generateIdentity();
    const bob = generateIdentity();
    const sealed = sealMessage('see you at eight', peerFrom(bob), alice, CLIENT_NONCE, ALICE_ID);

    const forBob = readMessage(messageFrom(sealed, 'both-1'), bob);
    expect(forBob).toMatchObject({ kind: 'encrypted' });
    if (forBob.kind !== 'encrypted') throw new Error('unreachable');
    expect(forBob.content.text).toBe('see you at eight');
    expect(forBob.content.commitmentVerified).toBe(true);

    // The sender reads the same message from their own copy. Without this their
    // outbox would be unreadable to them after a reload.
    clearDecryptionCache();
    const forAlice = readMessage(messageFrom(sealed, 'both-1'), alice);
    if (forAlice.kind !== 'encrypted') throw new Error('unreachable');
    expect(forAlice.content.text).toBe('see you at eight');
  });

  it('says "locked" without a key and "undecryptable" with the wrong one', () => {
    clearDecryptionCache();
    const alice = generateIdentity();
    const bob = generateIdentity();
    const eve = generateIdentity();
    const sealed = sealMessage('private', peerFrom(bob), alice, CLIENT_NONCE, ALICE_ID);

    // No key at all is something the user can fix by restoring; the wrong key
    // is not, and conflating the two would send them round a loop that cannot
    // succeed.
    expect(readMessage(messageFrom(sealed, 'locked-1'), null).kind).toBe('locked');
    expect(readMessage(messageFrom(sealed, 'eve-1'), eve).kind).toBe('undecryptable');
  });

  it('gives the recipient the franking key a report needs', () => {
    clearDecryptionCache();
    const alice = generateIdentity();
    const bob = generateIdentity();
    const sealed = sealMessage('reportable', peerFrom(bob), alice, CLIENT_NONCE, ALICE_ID);

    const opened = readMessage(messageFrom(sealed, 'report-1'), bob);
    if (opened.kind !== 'encrypted') throw new Error('unreachable');
    expect(opened.content.frankingKey).toHaveLength(32);
  });

  it('decrypts a conversation preview, so the list is not a wall of padlocks', () => {
    clearDecryptionCache();
    const alice = generateIdentity();
    const bob = generateIdentity();
    const sealed = sealMessage('the last thing said', peerFrom(bob), alice, CLIENT_NONCE, ALICE_ID);

    const conversation = {
      user_id: 'alice',
      username: 'alice',
      avatar_url: null,
      last_message_id: 'preview-1',
      last_message_sender_id: 'alice',
      last_message_body: null,
      last_message_ciphertext: sealed.ciphertext,
      last_message_nonce: sealed.nonce,
      last_message_sender_ephemeral_key: sealed.sender_ephemeral_key,
      last_message_sender_copy: sealed.sender_copy,
      last_message_at: new Date().toISOString(),
      last_message_read_at: null,
      unread_count: 1,
      can_message: true,
    } satisfies MessageConversation;

    const preview = readConversationPreview(conversation, bob);
    if (preview.kind !== 'encrypted') throw new Error('unreachable');
    expect(preview.content.text).toBe('the last thing said');
  });

  it('forgets decrypted text when asked, so it does not outlive a session', () => {
    const alice = generateIdentity();
    const bob = generateIdentity();
    const sealed = sealMessage('ephemeral', peerFrom(bob), alice, CLIENT_NONCE, ALICE_ID);

    expect(readMessage(messageFrom(sealed, 'cache-1'), bob).kind).toBe('encrypted');
    clearDecryptionCache();
    // Cleared rather than merely hidden: with no key the same message can no
    // longer be read, which would be impossible if the plaintext had stayed.
    expect(readMessage(messageFrom(sealed, 'cache-1'), null).kind).toBe('locked');
  });
});

describe('deciding whether a message is really from the sender', () => {
  it('accepts one signed by the key behind the safety number', () => {
    clearDecryptionCache();
    const alice = generateIdentity();
    const bob = generateIdentity();
    const sealed = sealMessage('genuinely mine', peerFrom(bob), alice, CLIENT_NONCE, ALICE_ID);

    const read = readMessage(
      messageFrom(sealed, 'signed-1'),
      bob,
      alice.signingPublicKey,
      BOB_THREAD,
    );
    if (read.kind !== 'encrypted') throw new Error('unreachable');
    expect(read.content.authenticity).toBe('verified');
    expect(read.content.text).toBe('genuinely mine');
  });

  it('refuses to show one the trusted key did not sign', () => {
    // The attack the signature exists to catch. Encryption is to a *public*
    // exchange key, so a server can compose a message that decrypts perfectly
    // and file it under whoever it likes; without this check the interface
    // draws it exactly like a real one.
    clearDecryptionCache();
    const alice = generateIdentity();
    const bob = generateIdentity();
    const server = generateIdentity();
    const forged = sealMessage('meet me at the docks', peerFrom(bob), server, CLIENT_NONCE, ALICE_ID);

    const read = readMessage(
      // Recorded as signed by Alice's current key, which is what makes this
      // tampering rather than an old message from a key she has since replaced.
      messageFrom(forged, 'forged-1', { sender_signing_key: toHex(alice.signingPublicKey) }),
      bob,
      alice.signingPublicKey,
      BOB_THREAD,
    );
    expect(read).toEqual({ kind: 'untrusted', reason: 'forged' });
  });

  it('withholds one signed by a key it cannot place, rather than showing it with a note', () => {
    // This used to be shown, annotated "not authenticated". M09 of the
    // September audit is why it no longer is: whether a bad signature reads as
    // `forged` or `unrecognised` turns on `sender_signing_key`, which the
    // server fills in. Declaring a key nobody has on record was enough to move
    // a message from refused to displayed, and the reader was left deciding
    // whether text attributed to a contact was real, from small print.
    //
    // The cost is deliberate and is the reason it was written the other way
    // first: history signed with a key that has since been rotated away is
    // legitimate, and is now withheld too.
    clearDecryptionCache();
    const alice = generateIdentity();
    const alicesOldKeys = generateIdentity();
    const bob = generateIdentity();
    const sealed = sealMessage('sent long ago', peerFrom(bob), alicesOldKeys, CLIENT_NONCE, ALICE_ID);

    const read = readMessage(
      messageFrom(sealed, 'rotated-1', {
        sender_signing_key: toHex(alicesOldKeys.signingPublicKey),
      }),
      bob,
      alice.signingPublicKey,
      BOB_THREAD,
    );
    expect(read.kind).toBe('untrusted');
    if (read.kind !== 'untrusted') throw new Error('unreachable');
    expect(read.reason).toBe('unrecognised');
    expect(JSON.stringify(read)).not.toContain('sent long ago');
  });

  it('withholds a copy sealed to this reader under a signature for somebody else', () => {
    // The re-addressing the November review found. Alice wrote to Carol; Carol,
    // or anyone she reported it to, knows the text and the franking key and can
    // seal the same thing to Bob, carrying Alice's signature along. Sealed to
    // Bob's keys here while naming Carol, which is exactly what that copy is.
    clearDecryptionCache();
    const alice = generateIdentity();
    const bob = generateIdentity();
    const resealed = sealMessage(
      'said to Carol, not to you',
      peerFrom(bob, CAROL_ID),
      alice,
      CLIENT_NONCE,
      ALICE_ID,
    );

    const read = readMessage(
      messageFrom(resealed, 'resealed-1', {
        sender_signing_key: toHex(alice.signingPublicKey),
      }),
      bob,
      alice.signingPublicKey,
      BOB_THREAD,
    );
    expect(read).toEqual({ kind: 'untrusted', reason: 'forged' });

    // Writing Carol into the row as the recipient does not help: the parties
    // checked are the thread's, not whatever the row claims.
    clearDecryptionCache();
    const rewritten = readMessage(
      messageFrom(resealed, 'resealed-2', {
        recipient_id: CAROL_ID,
        sender_signing_key: toHex(alice.signingPublicKey),
      }),
      bob,
      alice.signingPublicKey,
      BOB_THREAD,
    );
    expect(rewritten).toEqual({ kind: 'untrusted', reason: 'forged' });
  });

  it('claims nothing when it does not know whose thread this is', () => {
    clearDecryptionCache();
    const alice = generateIdentity();
    const bob = generateIdentity();
    const sealed = sealMessage('before the account loads', peerFrom(bob), alice, CLIENT_NONCE, ALICE_ID);

    const read = readMessage(messageFrom(sealed, 'no-thread-1'), bob, alice.signingPublicKey, null);
    if (read.kind !== 'encrypted') throw new Error('unreachable');
    expect(read.content.authenticity).toBe('unchecked');
  });

  it('claims nothing when there is no key to check against', () => {
    clearDecryptionCache();
    const alice = generateIdentity();
    const bob = generateIdentity();
    const sealed = sealMessage('while the directory loads', peerFrom(bob), alice, CLIENT_NONCE, ALICE_ID);

    const read = readMessage(messageFrom(sealed, 'unchecked-1'), bob, null);
    if (read.kind !== 'encrypted') throw new Error('unreachable');
    expect(read.content.authenticity).toBe('unchecked');
  });

  it('withholds text that does not open the commitment', () => {
    // A sender who encrypts abuse while committing to something harmless leaves
    // their victim with something they can read and can never report. Showing
    // it hands over the abuse and withholds the remedy.
    clearDecryptionCache();
    const alice = generateIdentity();
    const bob = generateIdentity();
    const sealed = sealMessage('what they will actually read', peerFrom(bob), alice, CLIENT_NONCE, ALICE_ID);
    const decoy = sealMessage('what they committed to', peerFrom(bob), alice, clientNonce(), ALICE_ID);

    const read = readMessage(
      messageFrom(sealed, 'malformed-1', { franking_commitment: decoy.franking_commitment }),
      bob,
    );
    expect(read).toEqual({ kind: 'untrusted', reason: 'malformed' });
  });
});

describe('a preview does not decide anything for the thread', () => {
  it('re-judges a message the conversation list had already decrypted', () => {
    // The list decrypts the newest message of every thread with neither a
    // commitment nor a trusted key, and caches it under the same id the thread
    // then reads. Inheriting those verdicts labelled the newest message of
    // every conversation a commitment mismatch — and, once a mismatch hides the
    // text, would have hidden it outright.
    clearDecryptionCache();
    const alice = generateIdentity();
    const bob = generateIdentity();
    const sealed = sealMessage('perfectly ordinary', peerFrom(bob), alice, CLIENT_NONCE, ALICE_ID);
    const id = 'shared-id-1';

    const conversation = {
      user_id: 'alice',
      username: 'alice',
      avatar_url: null,
      last_message_id: id,
      last_message_sender_id: 'alice',
      last_message_body: null,
      last_message_ciphertext: sealed.ciphertext,
      last_message_nonce: sealed.nonce,
      last_message_sender_ephemeral_key: sealed.sender_ephemeral_key,
      last_message_sender_copy: sealed.sender_copy,
      last_message_at: new Date().toISOString(),
      last_message_read_at: null,
      unread_count: 1,
      can_message: true,
    } satisfies MessageConversation;

    const preview = readConversationPreview(conversation, bob);
    if (preview.kind !== 'encrypted') throw new Error('unreachable');
    // Absent, not false: the preview had nothing to check.
    expect(preview.content.commitmentVerified).toBeNull();
    expect(preview.content.authenticity).toBe('unchecked');

    const inThread = readMessage(
      messageFrom(sealed, id),
      bob,
      alice.signingPublicKey,
      BOB_THREAD,
    );
    if (inThread.kind !== 'encrypted') throw new Error('unreachable');
    expect(inThread.content.commitmentVerified).toBe(true);
    expect(inThread.content.authenticity).toBe('verified');
    expect(inThread.content.text).toBe('perfectly ordinary');
  });
});

describe('the shared crypto modules', () => {
  it('verifies against the trusted key rather than the one delivered with the message', () => {
    // A signature checked against a key that arrived beside it proves only that
    // whoever sent both can do arithmetic. This is the one property that makes
    // the whole check worth doing, so it is asserted rather than assumed.
    clearDecryptionCache();
    const alice = generateIdentity();
    const bob = generateIdentity();
    const server = generateIdentity();
    const forged = sealMessage('trust me', peerFrom(bob), server, CLIENT_NONCE, ALICE_ID);

    const read = readMessage(
      // Everything the server controls says this is fine: its own signature,
      // its own key, recorded as the signing key. Only the directory disagrees.
      messageFrom(forged, 'substituted-1', {
        sender_signing_key: toHex(server.signingPublicKey),
      }),
      bob,
      fromHex(toHex(alice.signingPublicKey)),
      BOB_THREAD,
    );
    // Not merely "not verified": withheld. Everything the server controls says
    // the message is fine, and the only disagreement is the directory, so the
    // text must not be drawn on the strength of the server's own claim.
    expect(read.kind).toBe('untrusted');
    if (read.kind !== 'untrusted') throw new Error('unreachable');
    expect(read.reason).toBe('unrecognised');
    expect(JSON.stringify(read)).not.toContain('trust me');
  });
});
