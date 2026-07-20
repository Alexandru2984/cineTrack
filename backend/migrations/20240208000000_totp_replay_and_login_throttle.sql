-- Replay protection for accepted TOTP counters plus an account-scoped throttle
-- that works across backend workers and instances.
ALTER TABLE users
    ADD COLUMN totp_last_used_step BIGINT CHECK (totp_last_used_step >= 0),
    ADD COLUMN login_failed_attempts INTEGER NOT NULL DEFAULT 0
        CHECK (login_failed_attempts >= 0),
    ADD COLUMN login_last_failed_at TIMESTAMPTZ,
    ADD COLUMN login_locked_until TIMESTAMPTZ;
