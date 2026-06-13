ALTER TABLE refresh_tokens
ADD COLUMN IF NOT EXISTS consumed_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_active_user
ON refresh_tokens(user_id, created_at)
WHERE consumed_at IS NULL AND revoked_at IS NULL;
