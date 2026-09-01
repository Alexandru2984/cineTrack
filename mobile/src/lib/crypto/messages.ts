/** Turning stored envelopes back into text, and text into envelopes.
 *
 *  Everything here is synchronous and pulls in the primitives, so this module
 *  belongs to the messaging chunk rather than the initial route. The cache it
 *  uses lives in `cache.ts` for exactly that reason. */
import {
  assertPeerFingerprint,
  decryptMessage,
  encryptMessage,
  equalBytes,
  frankingCommitment,
  fromHex,
  toHex,
  verifyFrankingSignature,
  type IdentityKeyPair,
} from '@/lib/crypto/core';
import {
  lookup,
  remember,
  type DecryptedContent,
  type MessageAuthenticity,
} from '@/lib/crypto/cache';
import type { DirectMessage, MessageConversation, PeerPublicKeys } from '@/types';

export { clearDecryptionCache } from '@/lib/crypto/cache';
export type { DecryptedContent, MessageAuthenticity };

export type MessageContent =
  | { kind: 'plain'; text: string }
  | { kind: 'encrypted'; content: DecryptedContent }
  | { kind: 'locked' }
  | { kind: 'undecryptable' }
  /** Decrypted, and not shown. The text is deliberately absent from this
   *  variant rather than carried with a flag beside it: a caller cannot render
   *  what it was never handed, and every path that draws a message goes through
   *  here. */
  | { kind: 'untrusted'; reason: 'forged' | 'malformed' };

interface Envelope {
  ciphertext?: string | null;
  nonce?: string | null;
  sender_ephemeral_key?: string | null;
  sender_copy?: string | null;
  franking_commitment?: string | null;
  franking_signature?: string | null;
  client_nonce?: string | null;
  sender_signing_key?: string | null;
}

/** Was this written by the account it claims to come from?
 *
 *  Nothing in the encryption answers that. A message is sealed to the
 *  recipient's public exchange key, which is public, so a server can compose
 *  one that opens perfectly and attribute it to whoever it likes. The signature
 *  is the only field bound to an identity.
 *
 *  `trustedSigningKey` is the directory key behind the safety number, never the
 *  key the message arrived with. Checking a signature against a key delivered
 *  beside it would let whoever delivered both declare anything authentic — the
 *  recorded key is used only to tell a rotation apart from tampering. */
function authenticate(
  envelope: Envelope,
  trustedSigningKey: Uint8Array | null,
): MessageAuthenticity {
  const { franking_commitment: commitment, franking_signature: signature } = envelope;
  if (!trustedSigningKey || !commitment || !signature || !envelope.client_nonce) {
    return 'unchecked';
  }
  try {
    if (
      verifyFrankingSignature(
        fromHex(commitment),
        fromHex(signature),
        trustedSigningKey,
        envelope.client_nonce,
      )
    ) {
      return 'verified';
    }
    // A failure is only tampering when it fails under the key the sender is on
    // record as having signed with. Anything else — a rotation, a message
    // predating the column that records the key — is history this client cannot
    // authenticate, and calling that a forgery would accuse the wrong person.
    const recorded = envelope.sender_signing_key;
    if (recorded && equalBytes(fromHex(recorded), trustedSigningKey)) return 'forged';
  } catch {
    // Malformed hex is a failed check, not a crash.
  }
  return 'unrecognised';
}

/** The two cheap checks, kept apart from the expensive one.
 *
 *  Decryption is an X25519 agreement and is cached; these are an HMAC and an
 *  Ed25519 verification over 48 bytes. They are recomputed whenever the cached
 *  entry was reached with less information than the caller now has — which is
 *  what a conversation preview leaves behind, having neither a commitment nor a
 *  trusted key. */
function inspect(
  text: string,
  frankingKey: Uint8Array,
  envelope: Envelope,
  trustedSigningKey: Uint8Array | null,
): Pick<DecryptedContent, 'commitmentVerified' | 'authenticity'> {
  let commitmentVerified: boolean | null = null;
  if (envelope.franking_commitment) {
    try {
      commitmentVerified = equalBytes(
        frankingCommitment(frankingKey, text),
        fromHex(envelope.franking_commitment),
      );
    } catch {
      commitmentVerified = false;
    }
  }
  return { commitmentVerified, authenticity: authenticate(envelope, trustedSigningKey) };
}

/** What the reader is shown, given what the checks concluded.
 *
 *  Both refusals hide the text rather than annotating it. A forged message is
 *  not from the person it names, and drawing it in their thread is the whole
 *  attack. A message whose commitment does not open is one its recipient can
 *  never report — a sender can encrypt abuse while committing to something
 *  innocuous — so displaying it hands over the abuse and withholds the remedy. */
function present(content: DecryptedContent): MessageContent {
  if (content.authenticity === 'forged') return { kind: 'untrusted', reason: 'forged' };
  if (content.commitmentVerified === false) return { kind: 'untrusted', reason: 'malformed' };
  return { kind: 'encrypted', content };
}

function decryptEnvelope(
  id: string,
  envelope: Envelope,
  identity: IdentityKeyPair | null,
  trustedSigningKey: Uint8Array | null,
): MessageContent {
  if (!envelope.ciphertext || !envelope.nonce || !envelope.sender_ephemeral_key) {
    return { kind: 'undecryptable' };
  }
  if (!identity) return { kind: 'locked' };

  const cached = lookup(id);
  if (cached) {
    // Re-judged, not inherited. The conversation list decrypts the newest
    // message of every thread with neither a commitment nor a trusted key, and
    // that entry is stored under the same id the thread view then looks up. Its
    // verdicts describe what the preview could see, so they are recomputed here
    // as soon as this call can see more — and the plaintext, which is the part
    // that cost an X25519 agreement, is reused as it stands.
    const stale =
      (cached.commitmentVerified === null && Boolean(envelope.franking_commitment)) ||
      (cached.authenticity === 'unchecked' && trustedSigningKey !== null);
    if (!stale) return present(cached);
    const rejudged: DecryptedContent = {
      ...cached,
      ...inspect(cached.text, cached.frankingKey, envelope, trustedSigningKey),
    };
    remember(id, rejudged);
    return present(rejudged);
  }

  try {
    const result = decryptMessage(
      {
        ciphertext: fromHex(envelope.ciphertext),
        nonce: fromHex(envelope.nonce),
        senderEphemeralKey: fromHex(envelope.sender_ephemeral_key),
        senderCopy: envelope.sender_copy ? fromHex(envelope.sender_copy) : undefined,
        // Both franking fields are judged by `inspect`, which knows whether the
        // envelope carried them at all. `decryptMessage` is handed empty ones
        // so its own commitment answer is never the one that reaches the UI:
        // it cannot tell "did not match" from "was not asked".
        frankingCommitment: new Uint8Array(),
        frankingSignature: new Uint8Array(),
      },
      identity.exchangePrivateKey,
    );
    const content: DecryptedContent = {
      text: result.plaintext,
      frankingKey: result.frankingKey,
      ...inspect(result.plaintext, result.frankingKey, envelope, trustedSigningKey),
    };
    remember(id, content);
    return present(content);
  } catch {
    // Written for a key this device does not have — most often a message sent
    // before the user set encryption up on a previous device, or after they
    // replaced their keys elsewhere.
    return { kind: 'undecryptable' };
  }
}

/** Read one message from a thread.
 *
 *  `trustedSigningKey` is the Ed25519 key of whoever wrote it, as this device
 *  trusts it: the peer's directory entry for an incoming message, the reader's
 *  own for one they sent. Omitting it does not weaken a check into a pass — the
 *  message is reported as unchecked, which the interface says out loud rather
 *  than drawing it as authenticated. */
export function readMessage(
  message: DirectMessage,
  identity: IdentityKeyPair | null,
  trustedSigningKey: Uint8Array | null = null,
): MessageContent {
  if (message.body !== null && message.body !== undefined) {
    return { kind: 'plain', text: message.body };
  }
  return decryptEnvelope(message.id, message, identity, trustedSigningKey);
}

export function readConversationPreview(
  conversation: MessageConversation,
  identity: IdentityKeyPair | null,
): MessageContent {
  if (conversation.last_message_body !== null && conversation.last_message_body !== undefined) {
    return { kind: 'plain', text: conversation.last_message_body };
  }
  // A preview is not a report, and it is not an attribution either. The list
  // response carries neither the commitment nor the signature, and fetching a
  // directory entry per row to check one would cost a request per conversation.
  // So both verdicts come back absent, and they stay absent rather than
  // hardening into a `false` the thread view would later believe.
  //
  // The consequence, stated plainly: a message the thread view would refuse to
  // draw still appears as a one-line preview in the list. Closing that needs
  // the peer keys the list does not have.
  return decryptEnvelope(
    conversation.last_message_id,
    {
      ciphertext: conversation.last_message_ciphertext,
      nonce: conversation.last_message_nonce,
      sender_ephemeral_key: conversation.last_message_sender_ephemeral_key,
      sender_copy: conversation.last_message_sender_copy,
      franking_commitment: null,
    },
    identity,
    null,
  );
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
