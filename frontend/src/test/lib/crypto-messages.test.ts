import { describe, expect, it } from 'vitest';

import { generateIdentity, toHex } from '@/lib/crypto/core';
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

function peerFrom(identity: ReturnType<typeof generateIdentity>): PeerPublicKeys {
  return {
    user_id: 'peer',
    username: 'peer',
    exchange_public_key: toHex(identity.exchangePublicKey),
    signing_public_key: toHex(identity.signingPublicKey),
    key_fingerprint: 'f'.repeat(64),
    generation: 1,
    updated_at: new Date().toISOString(),
  };
}

function messageFrom(sealed: ReturnType<typeof sealMessage>, id = 'message-1'): DirectMessage {
  return {
    id,
    sender_id: 'alice',
    recipient_id: 'bob',
    body: null,
    ciphertext: sealed.ciphertext,
    nonce: sealed.nonce,
    sender_ephemeral_key: sealed.sender_ephemeral_key,
    sender_copy: sealed.sender_copy,
    franking_commitment: sealed.franking_commitment,
    read_at: null,
    created_at: new Date().toISOString(),
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
    const sealed = sealMessage('see you at eight', peerFrom(bob), alice, CLIENT_NONCE);

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
    const sealed = sealMessage('private', peerFrom(bob), alice, CLIENT_NONCE);

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
    const sealed = sealMessage('reportable', peerFrom(bob), alice, CLIENT_NONCE);

    const opened = readMessage(messageFrom(sealed, 'report-1'), bob);
    if (opened.kind !== 'encrypted') throw new Error('unreachable');
    expect(opened.content.frankingKey).toHaveLength(32);
  });

  it('decrypts a conversation preview, so the list is not a wall of padlocks', () => {
    clearDecryptionCache();
    const alice = generateIdentity();
    const bob = generateIdentity();
    const sealed = sealMessage('the last thing said', peerFrom(bob), alice, CLIENT_NONCE);

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
    const sealed = sealMessage('ephemeral', peerFrom(bob), alice, CLIENT_NONCE);

    expect(readMessage(messageFrom(sealed, 'cache-1'), bob).kind).toBe('encrypted');
    clearDecryptionCache();
    // Cleared rather than merely hidden: with no key the same message can no
    // longer be read, which would be impossible if the plaintext had stayed.
    expect(readMessage(messageFrom(sealed, 'cache-1'), null).kind).toBe('locked');
  });
});
