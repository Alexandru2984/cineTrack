-- Instant access-token revocation.
--
-- Until now, revoking a session only revoked its *refresh* token. An access
-- token already in an attacker's hands stayed valid for its full lifetime, so
-- "sign out everywhere", a password change after a compromise, and a
-- moderator's account action all left a window of up to JWT_EXPIRY_MINUTES in
-- which the stolen credential still worked. The gap was recorded as a residual
-- risk; this closes it.
--
-- The check has to run on every authenticated request, so it is served from an
-- in-process cache rather than from here. This table exists so a process
-- restart does not resurrect a revoked session: the cache is rebuilt from it at
-- startup. Rows are therefore short-lived — a revocation only has to outlive
-- the longest access token it could possibly affect (60 minutes, the upper
-- bound the configuration allows) — and are pruned continuously.
--
-- Two scopes, because the two questions are genuinely different:
--
--   'session' — subject_id is refresh_tokens.family_id, the identity that
--               survives rotation and is carried in the token's `sid` claim.
--               Exact: revoking one session cannot touch another.
--
--   'user'    — subject_id is users.id, and revoked_at is a cutoff: every
--               access token this account issued at or before it is refused.
--               This is the catch-all for "revoke everything", and it covers
--               the one case the session scope cannot. cap_active_refresh_tokens
--               DELETEs a user's oldest refresh row once they hold more than
--               five; that row's family_id is then gone from the database, so a
--               later user-wide revocation has no session id left to name,
--               while its access token can still be alive for a few minutes.
CREATE TABLE access_token_revocations (
    scope TEXT NOT NULL,
    subject_id UUID NOT NULL,
    revoked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (scope, subject_id),
    CONSTRAINT access_token_revocations_known_scope CHECK (scope IN ('session', 'user')),
    CONSTRAINT access_token_revocations_expires_after_revocation CHECK (expires_at > revoked_at)
);

-- The startup rebuild and the pruner both scan by expiry.
CREATE INDEX access_token_revocations_expires_at_idx
    ON access_token_revocations (expires_at);
