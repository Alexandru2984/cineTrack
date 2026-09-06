-- Revoking a session must outlive the row the interface named.
--
-- `refresh_tokens.family_id` is the session identity: it survives rotation, and
-- it is what an access token carries as `sid`. The row is not the session — it
-- is one link in a chain the client replaces on every refresh.
--
-- Revocation used to update only the row. A device that had already rotated
-- R0 into R1 kept R1, so the owner clicked revoke on the session list, was told
-- it worked, and the device carried on. The access-token side was cut for
-- 75 minutes and then the family became usable again.
--
-- Updating every row of the family is necessary but not sufficient: a rotation
-- committing concurrently inserts a successor the revoking statement's snapshot
-- never saw. So the family revocation is recorded here, and every rotation
-- checks it before issuing. The record has to outlive the longest refresh token
-- it could affect, which is `JWT_REFRESH_EXPIRY_DAYS`, bounded to 90.
CREATE TABLE IF NOT EXISTS revoked_refresh_families (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    family_id UUID NOT NULL,
    revoked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- When this record may be forgotten: past it, every refresh token of the
    -- family has expired on its own and the record has no work left to do.
    expires_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (user_id, family_id)
);

-- The pruner scans by expiry; the rotation path looks up by primary key.
CREATE INDEX IF NOT EXISTS idx_revoked_refresh_families_expiry
    ON revoked_refresh_families (expires_at);
