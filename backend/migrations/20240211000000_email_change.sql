-- Changing the address on an account is a two-step move: the new address has to
-- prove it can receive mail before it replaces the working one. Until it does,
-- the request lives here and nothing about the account changes, so a mistyped
-- or abandoned request simply expires instead of locking someone out of their
-- own login.
--
-- The pending address is kept here rather than on `users` so the uniqueness
-- constraint on `users.email` keeps meaning what it says: every row in that
-- column is an address that has been confirmed. Two people may have the same
-- change pending; only the first to confirm gets it.

CREATE TABLE email_change_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    new_email VARCHAR(255) NOT NULL,
    token_hash VARCHAR(255) NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One pending change per account, like the other token tables: asking again
-- replaces the previous request rather than leaving two live links in two
-- inboxes.
CREATE UNIQUE INDEX idx_email_change_tokens_user ON email_change_tokens (user_id);
