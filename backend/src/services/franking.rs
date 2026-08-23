//! Verifiable abuse reports for end-to-end encrypted messages.
//!
//! Encryption removes the server's ability to moderate: it cannot read a
//! message, so it cannot judge one. The naive alternative is to trust whatever
//! text the reporter types, which makes a report an accusation anybody can
//! fabricate about anybody. Neither is acceptable — the first abandons victims,
//! the second weaponises the report button.
//!
//! Franking resolves it. At send time the sender commits to the plaintext:
//!
//! ```text
//! commitment = HMAC-SHA256(franking_key, plaintext)
//! signature  = Ed25519(sender_signing_key, commitment || client_nonce)
//! ```
//!
//! The franking key travels *inside* the ciphertext, so only the participants
//! learn it. The server stores the commitment and the signature and can verify
//! neither on its own — it has no plaintext and no key.
//!
//! When the recipient reports, they reveal the plaintext and the franking key.
//! The server can then check both halves, and each closes a different hole:
//!
//! * the commitment proves the revealed text is exactly what was committed to,
//!   so a reporter cannot invent an accusation;
//! * the signature proves the sender authored that commitment for that message,
//!   so nobody else — including this server — can fabricate a report against
//!   somebody.
//!
//! The published franking design has the server MAC the commitment with a key
//! of its own. That is right when the *client* holds the franking metadata;
//! here the server stores it, so verifying its own storage would be circular.
//! The sender's signature is what makes the result meaningful, and it is
//! strictly stronger.
//!
//! # What this cannot do
//!
//! A malicious sender can encrypt one thing and commit to another. Their victim
//! then reports text that fails verification rather than text that convicts.
//! The answer is not here but on the receiving client, which recomputes the
//! commitment as it decrypts and marks a message that does not match — a
//! message nobody can report is itself the report-worthy event. `verify` returns
//! the distinction so that a mismatch is recorded rather than silently dropped.

use aws_lc_rs::signature::{UnparsedPublicKey, ED25519};
use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;
use uuid::Uuid;

type HmacSha256 = Hmac<Sha256>;

/// Length of a franking key and of the commitment it produces.
pub const FRANKING_KEY_BYTES: usize = 32;
pub const COMMITMENT_BYTES: usize = 32;
pub const SIGNATURE_BYTES: usize = 64;

/// Why a report's evidence did not hold up.
#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum FrankingFailure {
    /// The revealed plaintext does not open the stored commitment. Either the
    /// reporter altered the text, or the sender committed to something other
    /// than what they encrypted.
    CommitmentMismatch,
    /// The stored commitment was not signed by the account being reported.
    /// Nothing the reporter or the server holds can produce this signature, so
    /// a failure here means the evidence was assembled rather than observed.
    SignatureInvalid,
    /// Malformed input: wrong key, commitment or signature length.
    MalformedEvidence,
}

impl FrankingFailure {
    /// A message safe to return to the reporter. Deliberately uniform: telling
    /// them *which* half failed would help somebody probing the scheme, and the
    /// distinction is recorded server-side where moderators can see it.
    pub const fn public_message(self) -> &'static str {
        "The report evidence could not be verified"
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::CommitmentMismatch => "commitment_mismatch",
            Self::SignatureInvalid => "signature_invalid",
            Self::MalformedEvidence => "malformed_evidence",
        }
    }
}

/// Recompute the commitment a sender should have produced for this plaintext.
///
/// The HMAC key is the per-message franking key; the message is the plaintext
/// bytes exactly as the sender encrypted them. Any normalisation difference
/// between client and server would make every report fail, so the plaintext is
/// used verbatim and normalisation is the client's responsibility before it
/// commits.
pub fn commit(franking_key: &[u8], plaintext: &str) -> Result<Vec<u8>, FrankingFailure> {
    if franking_key.len() != FRANKING_KEY_BYTES {
        return Err(FrankingFailure::MalformedEvidence);
    }
    let mut mac =
        HmacSha256::new_from_slice(franking_key).map_err(|_| FrankingFailure::MalformedEvidence)?;
    mac.update(plaintext.as_bytes());
    Ok(mac.finalize().into_bytes().to_vec())
}

/// The bytes a sender signs: the commitment bound to the message it belongs to.
///
/// The binding is what stops a signature being lifted from one message and
/// presented for another. Without it, a commitment signed once would validate a
/// report about any message the same sender ever wrote.
///
/// The message is identified by its *client nonce*, not by its database id, and
/// the reason is timing rather than taste: the id is assigned by the INSERT,
/// long after the sender has to sign. Signing over it is impossible, so a
/// scheme that demanded it would be a scheme no client could ever satisfy. The
/// nonce is chosen by the sender before the request leaves, and
/// `direct_messages_sender_nonce_unique` makes (sender, nonce) identify exactly
/// one message — which is precisely the property the binding needs.
pub fn signing_payload(commitment: &[u8], client_nonce: Uuid) -> Vec<u8> {
    let mut payload = Vec::with_capacity(commitment.len() + 16);
    payload.extend_from_slice(commitment);
    payload.extend_from_slice(client_nonce.as_bytes());
    payload
}

/// Check a report's evidence against what was stored when the message was sent.
pub fn verify(
    stored_commitment: &[u8],
    stored_signature: &[u8],
    sender_signing_key: &[u8],
    client_nonce: Uuid,
    revealed_plaintext: &str,
    franking_key: &[u8],
) -> Result<(), FrankingFailure> {
    if stored_commitment.len() != COMMITMENT_BYTES
        || stored_signature.len() != SIGNATURE_BYTES
        || sender_signing_key.len() != 32
    {
        return Err(FrankingFailure::MalformedEvidence);
    }

    // Commitment first: it is the cheaper check and the one a mistaken report
    // fails, so the expensive signature verification is reserved for evidence
    // that at least opens.
    let recomputed = commit(franking_key, revealed_plaintext)?;
    // Constant-time: a byte-by-byte comparison would let a reporter search for
    // a plaintext matching a commitment they cannot open.
    if !constant_time_eq(&recomputed, stored_commitment) {
        return Err(FrankingFailure::CommitmentMismatch);
    }

    let payload = signing_payload(stored_commitment, client_nonce);
    UnparsedPublicKey::new(&ED25519, sender_signing_key)
        .verify(&payload, stored_signature)
        .map_err(|_| FrankingFailure::SignatureInvalid)
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right.iter())
        .fold(0_u8, |difference, (a, b)| difference | (a ^ b))
        == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_lc_rs::signature::{Ed25519KeyPair, KeyPair};

    struct Sender {
        key_pair: Ed25519KeyPair,
    }

    impl Sender {
        fn new() -> Self {
            let rng = aws_lc_rs::rand::SystemRandom::new();
            let document = Ed25519KeyPair::generate_pkcs8(&rng).expect("key generation");
            Self {
                key_pair: Ed25519KeyPair::from_pkcs8(document.as_ref()).expect("key parsing"),
            }
        }

        fn public_key(&self) -> Vec<u8> {
            self.key_pair.public_key().as_ref().to_vec()
        }

        fn sign(&self, commitment: &[u8], client_nonce: Uuid) -> Vec<u8> {
            self.key_pair
                .sign(&signing_payload(commitment, client_nonce))
                .as_ref()
                .to_vec()
        }
    }

    fn evidence() -> (Sender, Uuid, Vec<u8>, String, Vec<u8>, Vec<u8>) {
        let sender = Sender::new();
        let client_nonce = Uuid::new_v4();
        let franking_key = vec![7u8; FRANKING_KEY_BYTES];
        let plaintext = "meet me at the usual place".to_string();
        let commitment = commit(&franking_key, &plaintext).expect("commitment");
        let signature = sender.sign(&commitment, client_nonce);
        (
            sender,
            client_nonce,
            franking_key,
            plaintext,
            commitment,
            signature,
        )
    }

    #[test]
    fn honest_evidence_verifies() {
        let (sender, client_nonce, key, plaintext, commitment, signature) = evidence();
        assert!(verify(
            &commitment,
            &signature,
            &sender.public_key(),
            client_nonce,
            &plaintext,
            &key,
        )
        .is_ok());
    }

    #[test]
    fn a_reporter_cannot_invent_the_text() {
        // The whole point: without this, a report is an accusation anybody can
        // fabricate about anybody.
        let (sender, client_nonce, key, _plaintext, commitment, signature) = evidence();
        let result = verify(
            &commitment,
            &signature,
            &sender.public_key(),
            client_nonce,
            "something the sender never wrote",
            &key,
        );
        assert_eq!(result, Err(FrankingFailure::CommitmentMismatch));
    }

    #[test]
    fn a_reporter_cannot_substitute_their_own_franking_key() {
        // Choosing a key that makes their text open the stored commitment is
        // exactly the forgery the commitment must resist.
        let (sender, client_nonce, _key, plaintext, commitment, signature) = evidence();
        let result = verify(
            &commitment,
            &signature,
            &sender.public_key(),
            client_nonce,
            &plaintext,
            &[9u8; FRANKING_KEY_BYTES],
        );
        assert_eq!(result, Err(FrankingFailure::CommitmentMismatch));
    }

    #[test]
    fn a_signature_from_another_account_is_refused() {
        // Nobody but the sender can produce this signature — including the
        // server, which is what makes a verified report meaningful rather than
        // merely server-attested.
        let (_sender, client_nonce, key, plaintext, commitment, _signature) = evidence();
        let impostor = Sender::new();
        let forged = impostor.sign(&commitment, client_nonce);
        let victim = Sender::new();

        let result = verify(
            &commitment,
            &forged,
            &victim.public_key(),
            client_nonce,
            &plaintext,
            &key,
        );
        assert_eq!(result, Err(FrankingFailure::SignatureInvalid));
    }

    #[test]
    fn a_signature_cannot_be_lifted_onto_another_message() {
        // Without the nonce in the signed payload, one signed commitment would
        // validate a report about any message the same sender wrote.
        let (sender, client_nonce, key, plaintext, commitment, signature) = evidence();
        let other_message = Uuid::new_v4();
        assert_ne!(client_nonce, other_message);

        let result = verify(
            &commitment,
            &signature,
            &sender.public_key(),
            other_message,
            &plaintext,
            &key,
        );
        assert_eq!(result, Err(FrankingFailure::SignatureInvalid));
    }

    #[test]
    fn malformed_evidence_is_rejected_before_any_comparison() {
        let (sender, client_nonce, key, plaintext, commitment, signature) = evidence();

        for (commitment, signature, public_key, franking_key) in [
            (
                &commitment[..31],
                &signature[..],
                sender.public_key(),
                &key[..],
            ),
            (
                &commitment[..],
                &signature[..63],
                sender.public_key(),
                &key[..],
            ),
            (&commitment[..], &signature[..], vec![0u8; 31], &key[..]),
            (
                &commitment[..],
                &signature[..],
                sender.public_key(),
                &key[..31],
            ),
        ] {
            assert_eq!(
                verify(
                    commitment,
                    signature,
                    &public_key,
                    client_nonce,
                    &plaintext,
                    franking_key,
                ),
                Err(FrankingFailure::MalformedEvidence),
            );
        }
    }

    #[test]
    fn the_public_failure_message_does_not_say_which_half_failed() {
        // Telling a reporter which check failed would help somebody probing the
        // scheme; moderators see the distinction server-side instead.
        let messages: Vec<&str> = [
            FrankingFailure::CommitmentMismatch,
            FrankingFailure::SignatureInvalid,
            FrankingFailure::MalformedEvidence,
        ]
        .iter()
        .map(|failure| failure.public_message())
        .collect();
        assert_eq!(
            messages
                .iter()
                .collect::<std::collections::HashSet<_>>()
                .len(),
            1
        );
    }

    #[test]
    fn the_commitment_covers_the_exact_plaintext() {
        // Any normalisation difference between client and server would make
        // every report fail, so the bytes are used verbatim.
        let key = vec![3u8; FRANKING_KEY_BYTES];
        assert_ne!(
            commit(&key, "hello").unwrap(),
            commit(&key, "hello ").unwrap()
        );
        assert_ne!(
            commit(&key, "Hello").unwrap(),
            commit(&key, "hello").unwrap()
        );
    }
}
