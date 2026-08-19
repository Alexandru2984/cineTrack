/** Turning stored envelopes back into text, and text into envelopes.
 *
 *  The decryption cache is what makes this practical to call from render. An
 *  X25519 agreement per message is roughly a millisecond, which is nothing once
 *  and noticeable when a fifty-message thread re-renders on every keystroke in
 *  the composer. Messages are immutable, so a cache keyed by id can never be
 *  stale. */
import {
  decryptMessage,
  encryptMessage,
  fromHex,
  toHex,
  type IdentityKeyPair,
} from '@/lib/crypto/core';
import type { DirectMessage, MessageConversation, PeerPublicKeys } from '@/types';

export interface DecryptedContent {
  text: string;
  /** Opens the sender's commitment. Held only in memory, and only so a report
   *  can carry it: it is the difference between a moderator seeing text the
   *  sender provably wrote and text the reporter typed. */
  frankingKey: Uint8Array;
  /** False when the sender encrypted one thing and committed to another. Such a
   *  message cannot be reported, so saying so beats showing it as ordinary. */
  commitmentVerified: boolean;
}

export type MessageContent =
  | { kind: 'plain'; text: string }
  | { kind: 'encrypted'; content: DecryptedContent }
  | { kind: 'locked' }
  | { kind: 'undecryptable' };

const cache = new Map<string, DecryptedContent>();
/** Bounded so a long-lived tab scrolling years of history cannot grow without
 *  limit. Oldest-first eviction matches how threads are read. */
const CACHE_LIMIT = 500;

function remember(id: string, content: DecryptedContent) {
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(id, content);
}

/** Forget every decrypted message. Called on sign-out, so plaintext does not
 *  outlive the session in memory. */
export function clearDecryptionCache() {
  cache.clear();
}

interface Envelope {
  ciphertext?: string | null;
  nonce?: string | null;
  sender_ephemeral_key?: string | null;
  franking_commitment?: string | null;
}

function decryptEnvelope(
  id: string,
  envelope: Envelope,
  identity: IdentityKeyPair | null,
): MessageContent {
  if (!envelope.ciphertext || !envelope.nonce || !envelope.sender_ephemeral_key) {
    return { kind: 'undecryptable' };
  }
  if (!identity) return { kind: 'locked' };

  const cached = cache.get(id);
  if (cached) return { kind: 'encrypted', content: cached };

  try {
    const result = decryptMessage(
      {
        ciphertext: fromHex(envelope.ciphertext),
        nonce: fromHex(envelope.nonce),
        senderEphemeralKey: fromHex(envelope.sender_ephemeral_key),
        frankingCommitment: fromHex(envelope.franking_commitment ?? ''),
        // Verified by the server at report time, never here — a client holding
        // the signature could only mislead itself about having checked it.
        frankingSignature: new Uint8Array(),
      },
      identity.exchangePrivateKey,
    );
    const content: DecryptedContent = {
      text: result.plaintext,
      frankingKey: result.frankingKey,
      commitmentVerified: result.commitmentVerified,
    };
    remember(id, content);
    return { kind: 'encrypted', content };
  } catch {
    // Written for a key this device does not have — most often a message sent
    // before the user set encryption up on a previous device, or after they
    // replaced their keys elsewhere.
    return { kind: 'undecryptable' };
  }
}

export function readMessage(
  message: DirectMessage,
  identity: IdentityKeyPair | null,
): MessageContent {
  if (message.body !== null && message.body !== undefined) {
    return { kind: 'plain', text: message.body };
  }
  return decryptEnvelope(message.id, message, identity);
}

export function readConversationPreview(
  conversation: MessageConversation,
  identity: IdentityKeyPair | null,
): MessageContent {
  if (conversation.last_message_body !== null && conversation.last_message_body !== undefined) {
    return { kind: 'plain', text: conversation.last_message_body };
  }
  return decryptEnvelope(conversation.last_message_id, {
    ciphertext: conversation.last_message_ciphertext,
    nonce: conversation.last_message_nonce,
    sender_ephemeral_key: conversation.last_message_sender_ephemeral_key,
    // A preview is not a report. Without the commitment the decryption still
    // succeeds; only `commitmentVerified` is meaningless, and nothing here
    // reads it.
    franking_commitment: null,
  }, identity);
}

export interface EncryptedPayload {
  ciphertext: string;
  nonce: string;
  sender_ephemeral_key: string;
  franking_commitment: string;
  franking_signature: string;
}

/** Build the envelope for a message about to be sent.
 *
 *  The client nonce is signed along with the commitment: it is the only
 *  identifier the sender knows before the server assigns a row id, and the
 *  server's uniqueness constraint makes it identify exactly one message. */
export function sealMessage(
  plaintext: string,
  peer: PeerPublicKeys,
  identity: IdentityKeyPair,
  clientNonce: string,
): EncryptedPayload {
  const envelope = encryptMessage(
    plaintext,
    fromHex(peer.exchange_public_key),
    identity.signingPrivateKey,
    clientNonce,
  );
  return {
    ciphertext: toHex(envelope.ciphertext),
    nonce: toHex(envelope.nonce),
    sender_ephemeral_key: toHex(envelope.senderEphemeralKey),
    franking_commitment: toHex(envelope.frankingCommitment),
    franking_signature: toHex(envelope.frankingSignature),
  };
}
