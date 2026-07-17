-- Email verification. Adds a per-user verified flag and a one-time, hashed
-- confirmation token store mirroring password_reset_tokens (only the SHA-256
-- hash is persisted, one active token per account).

ALTER TABLE users
    ADD COLUMN email_verified BOOLEAN NOT NULL DEFAULT FALSE;

-- Grandfather every existing account: they are already active, so a production
-- rollout must never retroactively mark them unverified. Only registrations
-- created after this migration start unverified.
UPDATE users SET email_verified = TRUE;

CREATE TABLE email_verification_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(255) NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One active token per account (the issuing upsert relies on this).
CREATE UNIQUE INDEX idx_email_verification_tokens_user
    ON email_verification_tokens(user_id);
