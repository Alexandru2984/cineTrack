use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use uuid::Uuid;
use validator::ValidationError;

pub const MAX_MESSAGE_CHARACTERS: usize = 2_000;

fn normalized_message_body(value: &str) -> String {
    value.trim().replace("\r\n", "\n").replace('\r', "\n")
}

fn validate_message_body(value: &str) -> Result<(), ValidationError> {
    let normalized = normalized_message_body(value);
    if normalized.is_empty() || normalized.chars().count() > MAX_MESSAGE_CHARACTERS {
        let mut error = ValidationError::new("invalid_message_length");
        error.message =
            Some(format!("Message must be 1-{MAX_MESSAGE_CHARACTERS} characters").into());
        return Err(error);
    }

    if normalized
        .chars()
        .any(|character| character.is_control() && !matches!(character, '\n' | '\t'))
    {
        let mut error = ValidationError::new("invalid_message_control_character");
        error.message = Some("Message contains unsupported control characters".into());
        return Err(error);
    }

    Ok(())
}

/// A message in one of two forms.
///
/// Plaintext for conversations where somebody has not published keys yet, and
/// an encrypted envelope where both sides have. An enum rather than a struct of
/// optionals, so the two cannot be mixed or both omitted — the database enforces
/// the same thing, and a request shape able to express an impossible row only
/// moves the error later.
///
/// The variants carry `client_nonce` each rather than sharing it through
/// `#[serde(flatten)]`: serde cannot combine `flatten` with
/// `deny_unknown_fields`, and silently treats every field as unknown, which
/// rejects every well-formed request. Repeating one field is the smaller cost.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum SendMessageRequest {
    Encrypted {
        client_nonce: Uuid,
        #[serde(flatten)]
        envelope: EncryptedEnvelope,
    },
    Plaintext {
        client_nonce: Uuid,
        body: String,
        /// Anything else the client sent.
        ///
        /// `deny_unknown_fields` is a container attribute — serde does not
        /// accept it on an enum variant — so strictness is restored by hand.
        /// Without it the plaintext arm quietly absorbs a half-built envelope:
        /// a client that meant to encrypt, got one field wrong, and sent a body
        /// alongside would have its plaintext stored by a server it had asked
        /// for encryption. Collecting the strays turns that into a 400.
        #[serde(flatten)]
        rest: BTreeMap<String, serde_json::Value>,
    },
}

/// Opaque to the server. Every field is validated for shape and length so a
/// malformed row cannot be stored, and for nothing else: the meaning belongs to
/// the two clients.
#[derive(Debug, Deserialize)]
pub struct EncryptedEnvelope {
    pub ciphertext: String,
    pub nonce: String,
    pub sender_ephemeral_key: String,
    /// The message key wrapped to the sender's own exchange key, so they can
    /// read their own outbox. See the migration for why this is not optional
    /// in practice even though the column allows NULL.
    pub sender_copy: String,
    pub franking_commitment: String,
    pub franking_signature: String,
}

/// Decoded envelope bytes, ready to store.
pub struct DecodedEnvelope {
    pub ciphertext: Vec<u8>,
    pub nonce: Vec<u8>,
    pub sender_ephemeral_key: Vec<u8>,
    pub sender_copy: Vec<u8>,
    pub franking_commitment: Vec<u8>,
    pub franking_signature: Vec<u8>,
}

impl EncryptedEnvelope {
    /// Sizes are fixed by the algorithms, so anything else is a client bug or an
    /// attempt to use the table as storage. Checked here as well as by the
    /// database CHECK so the caller gets a 400 rather than a 500.
    pub fn decode(&self) -> Result<DecodedEnvelope, ValidationError> {
        fn field(value: &str, expected: Option<usize>) -> Result<Vec<u8>, ValidationError> {
            let bytes = hex::decode(value).map_err(|_| ValidationError::new("invalid_hex"))?;
            match expected {
                Some(length) if bytes.len() != length => {
                    Err(ValidationError::new("invalid_length"))
                }
                None if !(16..=16384).contains(&bytes.len()) => {
                    Err(ValidationError::new("invalid_length"))
                }
                _ => Ok(bytes),
            }
        }

        Ok(DecodedEnvelope {
            ciphertext: field(&self.ciphertext, None)?,
            nonce: field(&self.nonce, Some(12))?,
            sender_ephemeral_key: field(&self.sender_ephemeral_key, Some(32))?,
            sender_copy: field(&self.sender_copy, Some(48))?,
            franking_commitment: field(&self.franking_commitment, Some(32))?,
            franking_signature: field(&self.franking_signature, Some(64))?,
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MarkThreadReadRequest {
    pub through_id: Uuid,
}

impl SendMessageRequest {
    pub fn client_nonce(&self) -> Uuid {
        match self {
            Self::Encrypted { client_nonce, .. } | Self::Plaintext { client_nonce, .. } => {
                *client_nonce
            }
        }
    }

    /// Plaintext still passes through the same normalisation and validation it
    /// always did. Encrypted content deliberately does not: the server cannot
    /// read it, so it cannot normalise it, and the sender's franking commitment
    /// is over the exact bytes they encrypted. Trimming here would break every
    /// report on a message that happened to end in a space.
    pub fn validate_content(&self) -> Result<(), ValidationError> {
        match self {
            Self::Plaintext { body, rest, .. } => {
                if !rest.is_empty() {
                    let mut error = ValidationError::new("unknown_message_fields");
                    error.message = Some(
                        "A message is either plain text or a complete encrypted \
                              envelope, not a mixture of the two"
                            .into(),
                    );
                    return Err(error);
                }
                validate_message_body(body)
            }
            Self::Encrypted { envelope, .. } => envelope.decode().map(|_| ()),
        }
    }

    pub fn normalized_body(&self) -> Option<String> {
        match self {
            Self::Plaintext { body, .. } => Some(normalized_message_body(body)),
            Self::Encrypted { .. } => None,
        }
    }

    pub fn envelope(&self) -> Option<&EncryptedEnvelope> {
        match self {
            Self::Encrypted { envelope, .. } => Some(envelope),
            Self::Plaintext { .. } => None,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MessageHistoryParams {
    pub limit: Option<u32>,
    pub before: Option<DateTime<Utc>>,
    pub before_id: Option<Uuid>,
}

impl MessageHistoryParams {
    pub fn limit_val(&self) -> i64 {
        self.limit.unwrap_or(50).clamp(1, 100) as i64
    }

    pub fn cursor(&self) -> Result<Option<(DateTime<Utc>, Uuid)>, &'static str> {
        match (self.before, self.before_id) {
            (Some(timestamp), Some(id)) => Ok(Some((timestamp, id))),
            (None, None) => Ok(None),
            _ => Err("Both before and before_id are required for message pagination"),
        }
    }
}

/// A message as returned to a participant.
///
/// Exactly one of `body` or the encrypted fields is present, mirroring the
/// database constraint. A client that finds neither is looking at a row it does
/// not understand and should say so rather than render an empty bubble.
///
/// The franking signature is deliberately absent: only the server needs it, to
/// verify a report. Sending it to clients would invite one to believe it had
/// verified something it cannot — it has no way to know the sender's key was
/// not substituted, which is the fingerprint's job.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct DirectMessageResponse {
    pub id: Uuid,
    pub sender_id: Uuid,
    pub recipient_id: Uuid,
    pub body: Option<String>,
    #[sqlx(default)]
    #[serde(serialize_with = "serialize_optional_hex")]
    pub ciphertext: Option<Vec<u8>>,
    #[sqlx(default)]
    #[serde(serialize_with = "serialize_optional_hex")]
    pub nonce: Option<Vec<u8>>,
    #[sqlx(default)]
    #[serde(serialize_with = "serialize_optional_hex")]
    pub sender_ephemeral_key: Option<Vec<u8>>,
    /// Meaningless to the recipient and essential to the sender: it is what
    /// lets them read their own outbox.
    #[sqlx(default)]
    #[serde(serialize_with = "serialize_optional_hex")]
    pub sender_copy: Option<Vec<u8>>,
    /// Returned so the recipient can check that what they decrypted is what the
    /// sender committed to. A mismatch means the message cannot be reported
    /// through the normal path, which is itself worth surfacing.
    #[sqlx(default)]
    #[serde(serialize_with = "serialize_optional_hex")]
    pub franking_commitment: Option<Vec<u8>>,
    pub read_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

fn serialize_optional_hex<S>(value: &Option<Vec<u8>>, serializer: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    match value {
        Some(bytes) => serializer.serialize_some(&hex::encode(bytes)),
        None => serializer.serialize_none(),
    }
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct ConversationResponse {
    pub user_id: Uuid,
    pub username: String,
    pub avatar_url: Option<String>,
    pub last_message_id: Uuid,
    pub last_message_sender_id: Uuid,
    /// Absent for encrypted messages: the server has nothing to preview. The
    /// client substitutes its own decrypted preview, or a placeholder when it
    /// cannot decrypt.
    pub last_message_body: Option<String>,
    /// The last message's envelope, when it has one.
    ///
    /// Carried here so the conversation list can show a real preview rather
    /// than a padlock and the word "encrypted". The alternative — fetching each
    /// thread to preview it — would be one request per row, and a placeholder
    /// would make the list useless for the thing a list is for: deciding which
    /// conversation to open.
    ///
    /// The franking commitment is deliberately absent: a preview is not a
    /// report, and the thread view carries it for the messages that are.
    #[serde(serialize_with = "serialize_optional_hex")]
    #[sqlx(default)]
    pub last_message_ciphertext: Option<Vec<u8>>,
    #[serde(serialize_with = "serialize_optional_hex")]
    #[sqlx(default)]
    pub last_message_nonce: Option<Vec<u8>>,
    #[serde(serialize_with = "serialize_optional_hex")]
    #[sqlx(default)]
    pub last_message_sender_ephemeral_key: Option<Vec<u8>>,
    #[serde(serialize_with = "serialize_optional_hex")]
    #[sqlx(default)]
    pub last_message_sender_copy: Option<Vec<u8>>,
    pub last_message_at: DateTime<Utc>,
    pub last_message_read_at: Option<DateTime<Utc>>,
    pub unread_count: i64,
    pub can_message: bool,
}

#[derive(Debug, Serialize)]
pub struct MessagePeerResponse {
    pub id: Uuid,
    pub username: String,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct MessageThreadResponse {
    pub user: MessagePeerResponse,
    pub can_message: bool,
    pub messages: Vec<DirectMessageResponse>,
}

#[derive(Debug, Serialize)]
pub struct MessageSummaryResponse {
    pub unread_count: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plaintext(body: &str) -> SendMessageRequest {
        SendMessageRequest::Plaintext {
            body: body.to_string(),
            client_nonce: Uuid::new_v4(),
            rest: BTreeMap::new(),
        }
    }

    fn envelope() -> EncryptedEnvelope {
        EncryptedEnvelope {
            ciphertext: "11".repeat(64),
            nonce: "22".repeat(12),
            sender_ephemeral_key: "33".repeat(32),
            sender_copy: "66".repeat(48),
            franking_commitment: "44".repeat(32),
            franking_signature: "55".repeat(64),
        }
    }

    #[test]
    fn message_body_is_trimmed_and_normalizes_newlines() {
        let request = plaintext("  hello\r\nworld  ");
        assert!(request.validate_content().is_ok());
        assert_eq!(request.normalized_body().as_deref(), Some("hello\nworld"));
    }

    #[test]
    fn message_body_rejects_blank_oversized_and_control_characters() {
        for body in [
            "   ".to_string(),
            "x".repeat(MAX_MESSAGE_CHARACTERS + 1),
            "hello\0world".to_string(),
        ] {
            assert!(plaintext(&body).validate_content().is_err());
        }
    }

    #[test]
    fn an_encrypted_message_carries_no_plaintext() {
        // The two forms are exclusive by construction, which is what stops a
        // row existing that readers would have to guess about.
        let request = SendMessageRequest::Encrypted {
            envelope: envelope(),
            client_nonce: Uuid::new_v4(),
        };
        assert!(request.validate_content().is_ok());
        assert!(request.normalized_body().is_none());
        assert!(request.envelope().is_some());
    }

    #[test]
    fn encrypted_content_is_not_normalised() {
        // Trimming or rewriting newlines would change the bytes the sender
        // committed to, and every report on such a message would then fail
        // verification for no reason the user could understand.
        let request = SendMessageRequest::Encrypted {
            envelope: envelope(),
            client_nonce: Uuid::new_v4(),
        };
        let decoded = request.envelope().unwrap().decode().unwrap();
        assert_eq!(decoded.ciphertext, vec![0x11; 64]);
    }

    #[test]
    fn the_wire_format_resolves_to_exactly_one_form() {
        // The untagged enum is what the HTTP layer actually deserialises, so
        // the shapes matter more than the constructors above.
        let nonce = Uuid::new_v4();
        let plain: SendMessageRequest =
            serde_json::from_value(serde_json::json!({ "body": "hi", "client_nonce": nonce }))
                .expect("plaintext form must parse");
        assert_eq!(plain.normalized_body().as_deref(), Some("hi"));

        let encrypted: SendMessageRequest = serde_json::from_value(serde_json::json!({
            "client_nonce": nonce,
            "ciphertext": "11".repeat(64),
            "nonce": "22".repeat(12),
            "sender_ephemeral_key": "33".repeat(32),
            "sender_copy": "66".repeat(48),
            "franking_commitment": "44".repeat(32),
            "franking_signature": "55".repeat(64),
        }))
        .expect("encrypted form must parse");
        assert!(encrypted.normalized_body().is_none());

        // Neither form: refused at parse time rather than reaching the database.
        assert!(serde_json::from_value::<SendMessageRequest>(
            serde_json::json!({ "client_nonce": nonce })
        )
        .is_err());

        // A half-built envelope is not quietly downgraded to plaintext. This is
        // the case worth pinning: a client that sends a body alongside a broken
        // envelope must not have its plaintext stored on a server that was
        // asked for encryption.
        let mixed: SendMessageRequest = serde_json::from_value(serde_json::json!({
            "client_nonce": nonce,
            "body": "hi",
            "ciphertext": "11".repeat(64),
        }))
        .expect("the plaintext arm absorbs the stray field");
        assert!(
            mixed.validate_content().is_err(),
            "a body sent alongside a broken envelope must not be stored as plaintext"
        );
    }

    #[test]
    fn envelope_fields_must_have_their_algorithm_sizes() {
        // Wrong sizes are a client bug, and refusing them here turns what would
        // be a database error into a clear 400.
        for mutate in [
            |e: &mut EncryptedEnvelope| e.nonce = "22".repeat(11),
            |e: &mut EncryptedEnvelope| e.sender_ephemeral_key = "33".repeat(31),
            |e: &mut EncryptedEnvelope| e.sender_copy = "66".repeat(47),
            |e: &mut EncryptedEnvelope| e.franking_commitment = "44".repeat(33),
            |e: &mut EncryptedEnvelope| e.franking_signature = "55".repeat(63),
            |e: &mut EncryptedEnvelope| e.ciphertext = "11".repeat(4),
            |e: &mut EncryptedEnvelope| e.ciphertext = "zz".repeat(64),
        ] {
            let mut candidate = envelope();
            mutate(&mut candidate);
            assert!(candidate.decode().is_err());
        }
    }

    #[test]
    fn an_oversized_ciphertext_is_refused() {
        // The table is not storage: a ceiling keeps a client from parking
        // megabytes in a message row.
        let mut candidate = envelope();
        candidate.ciphertext = "11".repeat(16_385);
        assert!(candidate.decode().is_err());
    }

    #[test]
    fn message_cursor_requires_complete_pair_and_bounds_limit() {
        let timestamp = Utc::now();
        let id = Uuid::new_v4();
        assert!(MessageHistoryParams {
            limit: None,
            before: Some(timestamp),
            before_id: None,
        }
        .cursor()
        .is_err());
        assert_eq!(
            MessageHistoryParams {
                limit: Some(u32::MAX),
                before: Some(timestamp),
                before_id: Some(id),
            }
            .limit_val(),
            100
        );
    }
}
