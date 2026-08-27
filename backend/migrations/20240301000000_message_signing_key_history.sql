-- Keep the key that signed each message, so a report survives a key rotation.
--
-- `user_identity_keys` has `user_id` as its primary key and publishing new keys
-- does `ON CONFLICT DO UPDATE`, so the previous signing key is gone. Report
-- verification read the sender's *current* key, which made this work:
--
--   1. send an abusive message
--   2. rotate your keys
--   3. the victim reports it
--   4. the signature no longer verifies against the new key, report refused
--
-- The signature is over (commitment || client_nonce) and does not change, so
-- the only missing piece is which key to check it against. Recording it on the
-- message answers that permanently, and without a second table: a key is 32
-- bytes and a message already carries more than that in franking metadata.
--
-- Nullable on purpose. Messages sent before this column existed have no
-- recorded key, and report verification falls back to the sender's current key
-- for exactly those rows — the same behaviour they have today, no worse.
ALTER TABLE direct_messages
    ADD COLUMN sender_signing_key BYTEA;

ALTER TABLE direct_messages
    ADD CONSTRAINT direct_messages_sender_signing_key_length
    CHECK (sender_signing_key IS NULL OR OCTET_LENGTH(sender_signing_key) = 32);

-- The recorded key is part of the envelope's identity, so it is immutable like
-- the rest of it. A key that could be edited afterwards would defeat the point:
-- report verification is only meaningful if this is what was true when the
-- message was sent, not what somebody set later.
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
        OR NEW.sender_copy IS DISTINCT FROM OLD.sender_copy
        OR NEW.franking_commitment IS DISTINCT FROM OLD.franking_commitment
        OR NEW.franking_signature IS DISTINCT FROM OLD.franking_signature
        OR NEW.sender_signing_key IS DISTINCT FROM OLD.sender_signing_key
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
