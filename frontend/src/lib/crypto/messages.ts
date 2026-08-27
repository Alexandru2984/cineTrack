/** Turning stored envelopes back into text, and text into envelopes.
 *
 *  Everything here is synchronous and pulls in the primitives, so this module
 *  belongs to the messaging chunk rather than the initial route. The cache it
 *  uses lives in `cache.ts` for exactly that reason. */
import {
  assertPeerFingerprint,
  decryptMessage,
  encryptMessage,
  fromHex,
  toHex,
  type IdentityKeyPair,
} from '@/lib/crypto/core';
import { lookup, remember, type DecryptedContent } from '@/lib/crypto/cache';
import type { DirectMessage, MessageConversation, PeerPublicKeys } from '@/types';

export { clearDecryptionCache } from '@/lib/crypto/cache';
export type { DecryptedContent };

export type MessageContent =
  | { kind: 'plain'; text: string }
  | { kind: 'encrypted'; content: DecryptedContent }
  | { kind: 'locked' }
  | { kind: 'undecryptable' };

interface Envelope {
  ciphertext?: string | null;
  nonce?: string | null;
  sender_ephemeral_key?: string | null;
  sender_copy?: string | null;
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

  const cached = lookup(id);
  if (cached) return { kind: 'encrypted', content: cached };

  try {
    const result = decryptMessage(
      {
        ciphertext: fromHex(envelope.ciphertext),
        nonce: fromHex(envelope.nonce),
        senderEphemeralKey: fromHex(envelope.sender_ephemeral_key),
        senderCopy: envelope.sender_copy ? fromHex(envelope.sender_copy) : undefined,
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
    sender_copy: conversation.last_message_sender_copy,
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
  sender_copy: string;
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
  // Fail closed on a directory entry that contradicts itself. This does not
  // stop a competent substitution — an attacker swapping the key swaps the
  // fingerprint with it, and only the out-of-band comparison catches that — but
  // sealing a message to a key whose own published identity does not match it
  // is never right, and doing it silently is how the mismatch would go unseen.
  assertPeerFingerprint(peer.exchange_public_key, peer.signing_public_key, peer.key_fingerprint);
  const envelope = encryptMessage(
    plaintext,
    fromHex(peer.exchange_public_key),
    identity.exchangePublicKey,
    identity.signingPrivateKey,
    clientNonce,
  );
  return {
    ciphertext: toHex(envelope.ciphertext),
    nonce: toHex(envelope.nonce),
    sender_ephemeral_key: toHex(envelope.senderEphemeralKey),
    sender_copy: toHex(envelope.senderCopy ?? new Uint8Array()),
    franking_commitment: toHex(envelope.frankingCommitment),
    franking_signature: toHex(envelope.frankingSignature),
  };
}
