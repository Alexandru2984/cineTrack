-- Optional TOTP two-factor authentication. The shared secret is stored hex
-- encoded and never serialized to clients; it exists while enrollment is
-- pending (totp_enabled = false) and after activation (totp_enabled = true).

ALTER TABLE users
    ADD COLUMN totp_secret TEXT,
    ADD COLUMN totp_enabled BOOLEAN NOT NULL DEFAULT FALSE;

-- Single-use recovery codes, stored only as SHA-256 hashes (like refresh and
-- reset tokens). Consumed codes are retained with a timestamp for audit.
CREATE TABLE two_factor_recovery_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash VARCHAR(255) NOT NULL,
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_two_factor_recovery_codes_user ON two_factor_recovery_codes(user_id);
CREATE UNIQUE INDEX idx_two_factor_recovery_codes_hash ON two_factor_recovery_codes(code_hash);
