-- The sender's own copy of the message key.
--
-- An ephemeral key that only the recipient can complete has a consequence that
-- is easy to miss until the feature is in front of a user: the sender cannot
-- read what they sent. Their ephemeral private key is discarded at send time,
-- and the history lives here rather than on their device, so their own outbox
-- would render as a column of padlocks after a reload.
--
-- The fix belongs in the envelope, not in a second copy of the message. The
-- client wraps the message key against the sender's own long-term exchange key
-- — using the same ephemeral private key, while it still exists — and stores
-- the wrapper here. The recipient's path is unchanged and this column means
-- nothing to them.
--
-- The server gains nothing either way: one more sealed box it has no key to.
--
-- Nullable, because messages sent before this column existed have no sender
-- copy and never will. Their senders keep whatever the client cached; there is
-- nothing to migrate, since the key needed to build a copy is gone.
ALTER TABLE direct_messages
    ADD COLUMN sender_copy BYTEA;

ALTER TABLE direct_messages
    -- 32 bytes of key under AES-256-GCM, plus its 16-byte tag. The nonce is the
    -- message's own: reusing it here is safe because this is a different key,
    -- and GCM requires uniqueness per key rather than globally.
    ADD CONSTRAINT direct_messages_sender_copy_size CHECK (
        sender_copy IS NULL OR OCTET_LENGTH(sender_copy) = 48
    ),
    -- A sender copy without a message to unlock is meaningless, and would be a
    -- sign that a client had built the envelope wrongly.
    ADD CONSTRAINT direct_messages_sender_copy_needs_ciphertext CHECK (
        sender_copy IS NULL OR ciphertext IS NOT NULL
    );

-- Immutable for the same reason as the rest of the envelope: rewriting it would
-- change which key a reader derives, and a message that opens differently after
-- the fact is not a message anybody can be held to.
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
