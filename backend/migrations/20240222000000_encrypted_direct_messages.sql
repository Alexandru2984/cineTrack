-- End-to-end encrypted direct messages, alongside the plaintext ones already
-- stored.
--
-- Migration is gradual on purpose. Existing messages stay exactly as they are
-- and stay readable; new ones are encrypted once both participants have
-- published keys. A flag day would mean either abandoning every existing
-- conversation or decrypting nothing, and neither is a trade worth making for
-- tidiness.
--
-- # What the server can and cannot do afterwards
--
-- It holds ciphertext, a nonce, an ephemeral public key, a commitment, and a
-- signature. It cannot read a message, and that is the point — but it also
-- cannot moderate one, which is why the commitment and signature exist. See the
-- note on franking below.

ALTER TABLE direct_messages
    -- Plaintext for messages sent before encryption, NULL for encrypted ones.
    ALTER COLUMN body DROP NOT NULL,
    -- AES-256-GCM ciphertext of the message, including its franking key.
    ADD COLUMN ciphertext BYTEA,
    ADD COLUMN nonce BYTEA,
    -- The sender's per-message X25519 public key. Ephemeral so that
    -- compromising a long-term key later does not decrypt past messages.
    ADD COLUMN sender_ephemeral_key BYTEA,
    -- HMAC-SHA256(franking_key, plaintext), computed by the sender.
    ADD COLUMN franking_commitment BYTEA,
    -- The sender's Ed25519 signature over the commitment and this message's
    -- identity. See below for why this is not optional.
    ADD COLUMN franking_signature BYTEA;

-- The old length check only makes sense for plaintext.
ALTER TABLE direct_messages
    DROP CONSTRAINT direct_messages_body_length;

ALTER TABLE direct_messages
    ADD CONSTRAINT direct_messages_body_length CHECK (
        body IS NULL OR CHAR_LENGTH(body) BETWEEN 1 AND 2000
    ),
    -- A message is one shape or the other, never both and never neither.
    -- Without this a row could carry plaintext *and* ciphertext, and every
    -- reader would have to guess which one is authoritative — the kind of
    -- ambiguity that ends with two clients showing different messages.
    ADD CONSTRAINT direct_messages_exactly_one_form CHECK (
        (
            body IS NOT NULL
            AND ciphertext IS NULL AND nonce IS NULL AND sender_ephemeral_key IS NULL
            AND franking_commitment IS NULL AND franking_signature IS NULL
        )
        OR (
            body IS NULL
            AND ciphertext IS NOT NULL AND nonce IS NOT NULL
            AND sender_ephemeral_key IS NOT NULL
            AND franking_commitment IS NOT NULL AND franking_signature IS NOT NULL
        )
    ),
    -- Sizes are fixed by the algorithms, so anything else is a client bug or an
    -- attempt to use the table as storage.
    ADD CONSTRAINT direct_messages_crypto_sizes CHECK (
        (nonce IS NULL OR OCTET_LENGTH(nonce) = 12)
        AND (sender_ephemeral_key IS NULL OR OCTET_LENGTH(sender_ephemeral_key) = 32)
        AND (franking_commitment IS NULL OR OCTET_LENGTH(franking_commitment) = 32)
        AND (franking_signature IS NULL OR OCTET_LENGTH(franking_signature) = 64)
        -- 2000 characters of UTF-8 plus the franking key, the GCM tag and
        -- padding. Generous, but still a ceiling.
        AND (ciphertext IS NULL OR OCTET_LENGTH(ciphertext) BETWEEN 16 AND 16384)
    );

-- The immutability trigger predates these columns and would happily let them be
-- rewritten after the fact.
--
-- That is not cosmetic. Abuse reporting on an encrypted message rests entirely
-- on the commitment being what the sender committed to at the time: if the
-- commitment could be edited, a report could be made to verify against text
-- that was never sent. The whole scheme is only as immutable as this function.
CREATE OR REPLACE FUNCTION enforce_direct_message_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF NEW.sender_id IS DISTINCT FROM OLD.sender_id
        OR NEW.recipient_id IS DISTINCT FROM OLD.recipient_id
        OR NEW.client_nonce IS DISTINCT FROM OLD.client_nonce
        OR NEW.body IS DISTINCT FROM OLD.body
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
        OR NEW.ciphertext IS DISTINCT FROM OLD.ciphertext
        OR NEW.nonce IS DISTINCT FROM OLD.nonce
        OR NEW.sender_ephemeral_key IS DISTINCT FROM OLD.sender_ephemeral_key
        OR NEW.franking_commitment IS DISTINCT FROM OLD.franking_commitment
        OR NEW.franking_signature IS DISTINCT FROM OLD.franking_signature
    THEN
        RAISE EXCEPTION 'direct message content and identity are immutable'
            USING ERRCODE = '23514';
    END IF;

    IF OLD.read_at IS NOT NULL AND NEW.read_at IS DISTINCT FROM OLD.read_at THEN
        RAISE EXCEPTION 'direct message read state cannot be reversed'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

-- Reports against an encrypted message carry the revealed plaintext and the
-- franking key that opens the commitment, so a moderator sees text the sender
-- provably wrote rather than text the reporter typed.
ALTER TABLE user_reports
    ADD COLUMN revealed_plaintext TEXT,
    ADD COLUMN franking_key BYTEA,
    -- NULL for reports the server could snapshot itself (profiles, lists, and
    -- plaintext messages). TRUE only when the commitment and the sender's
    -- signature both verified.
    ADD COLUMN franking_verified BOOLEAN;

ALTER TABLE user_reports
    ADD CONSTRAINT user_reports_franking_shape CHECK (
        (revealed_plaintext IS NULL AND franking_key IS NULL AND franking_verified IS NULL)
        OR (
            revealed_plaintext IS NOT NULL
            AND CHAR_LENGTH(revealed_plaintext) BETWEEN 1 AND 2000
            AND franking_key IS NOT NULL
            AND OCTET_LENGTH(franking_key) = 32
            AND franking_verified IS NOT NULL
        )
    );
