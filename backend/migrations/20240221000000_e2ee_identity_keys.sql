-- End-to-end encryption: the public half of each account's key material, and
-- the encrypted backup of the private half.
--
-- The server stores public keys so two people can address each other, and an
-- opaque blob it cannot open so a lost phone does not mean a lost history. It
-- never holds anything that decrypts a message.
--
-- # Why the server keeps a key directory at all
--
-- Somebody has to answer "what is this person's public key". Doing it here means
-- the server could substitute its own key and read the conversation — the
-- classic weakness of any managed directory. The mitigation is not to trust it:
-- `key_fingerprint` is derived from the keys themselves and shown to both
-- parties to compare out of band, so a substitution is detectable rather than
-- prevented. That is the same trade Signal makes with safety numbers.

CREATE TABLE user_identity_keys (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    -- X25519 public key for key agreement, raw 32 bytes.
    exchange_public_key BYTEA NOT NULL,
    -- Ed25519 public key for signatures, raw 32 bytes. Separate from the
    -- exchange key on purpose: reusing one key across two algorithms is a
    -- well-known footgun, and keeping them apart costs nothing here.
    signing_public_key BYTEA NOT NULL,
    -- Derived from both public keys by the client, and shown to the user as a
    -- safety number. Stored so the server can serve it without recomputing, and
    -- so a change is visible in one place.
    key_fingerprint TEXT NOT NULL,
    -- Bumped whenever the keys are replaced. A peer that has cached an older
    -- generation can tell it is stale without comparing key bytes.
    generation INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT user_identity_keys_exchange_length CHECK (OCTET_LENGTH(exchange_public_key) = 32),
    CONSTRAINT user_identity_keys_signing_length CHECK (OCTET_LENGTH(signing_public_key) = 32),
    CONSTRAINT user_identity_keys_fingerprint_shape CHECK (
        key_fingerprint ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT user_identity_keys_generation_positive CHECK (generation >= 1)
);

-- The encrypted private half. Opaque to the server by construction: it is
-- AES-GCM ciphertext under a key derived from the user's password with
-- Argon2id, and the password never reaches the server in a form that can derive
-- it (the login hash is a different Argon2 output with different parameters).
--
-- Two independent wrappings of the same secret, because either alone fails
-- badly. Password-only means changing a password would strand the history;
-- recovery-code-only means a code nobody kept is the only way in. With both, a
-- password change rewraps under the new password using the recovery code, and
-- either one alone can restore.
CREATE TABLE user_key_backups (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    -- Wrapped under the password-derived key.
    password_wrapped_key BYTEA NOT NULL,
    password_kdf_salt BYTEA NOT NULL,
    -- The Argon2id cost the wrapping used. Recorded rather than assumed: raising
    -- the default later must not make existing backups unopenable, and a client
    -- has no other way to know what to reproduce.
    password_kdf_memory_kib INTEGER NOT NULL,
    password_kdf_iterations INTEGER NOT NULL,
    password_kdf_parallelism INTEGER NOT NULL,
    -- Wrapped under a key derived from a recovery code shown once at setup.
    recovery_wrapped_key BYTEA NOT NULL,
    recovery_kdf_salt BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Bounded so a client cannot use this as free storage. A wrapped key pair is
    -- well under a kilobyte; the ceiling leaves room for a format change without
    -- inviting abuse.
    CONSTRAINT user_key_backups_password_blob_size CHECK (
        OCTET_LENGTH(password_wrapped_key) BETWEEN 32 AND 4096
    ),
    CONSTRAINT user_key_backups_recovery_blob_size CHECK (
        OCTET_LENGTH(recovery_wrapped_key) BETWEEN 32 AND 4096
    ),
    CONSTRAINT user_key_backups_salt_sizes CHECK (
        OCTET_LENGTH(password_kdf_salt) = 16 AND OCTET_LENGTH(recovery_kdf_salt) = 16
    ),
    -- Floors, not exact values, so the cost can be raised without a migration
    -- while still refusing a client that asks for something trivially weak.
    CONSTRAINT user_key_backups_kdf_cost CHECK (
        password_kdf_memory_kib >= 19456
        AND password_kdf_iterations >= 2
        AND password_kdf_parallelism BETWEEN 1 AND 4
    )
);

-- Publishing keys is a security-relevant act: it is what an attacker who has
-- taken an account would do to read future messages. It belongs in the same
-- timeline the owner already reviews.
--
-- The constraint is the inline one PostgreSQL named when the column was
-- declared, so it is dropped by that generated name rather than a nicer one
-- that was never assigned.
ALTER TABLE security_activity
    DROP CONSTRAINT security_activity_event_type_check;

ALTER TABLE security_activity
    ADD CONSTRAINT security_activity_event_type_check CHECK (
        event_type IN (
            'account_registered',
            'login_succeeded',
            'password_changed',
            'password_reset',
            'email_change_requested',
            'email_changed',
            'two_factor_enabled',
            'two_factor_disabled',
            'session_revoked',
            'all_sessions_revoked',
            'account_data_exported',
            'encryption_keys_published'
        )
    );
