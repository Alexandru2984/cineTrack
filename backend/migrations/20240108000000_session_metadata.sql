-- Session metadata for refresh tokens so users can review and revoke active
-- logins from the UI. user_agent/ip_address are best-effort, captured at issue
-- and rotation time; last_used_at advances on each refresh.
ALTER TABLE refresh_tokens
ADD COLUMN IF NOT EXISTS user_agent VARCHAR(512),
ADD COLUMN IF NOT EXISTS ip_address VARCHAR(45),
ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;
