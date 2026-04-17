-- Index for refresh token cleanup and cap queries that filter by user_id
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id, created_at);
