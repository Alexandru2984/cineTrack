-- Keep only the newest reset token before enforcing one token per account.
WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (
               PARTITION BY user_id
               ORDER BY created_at DESC, id DESC
           ) AS position
    FROM password_reset_tokens
)
DELETE FROM password_reset_tokens
WHERE id IN (SELECT id FROM ranked WHERE position > 1);

DROP INDEX IF EXISTS idx_password_reset_tokens_user;
CREATE UNIQUE INDEX idx_password_reset_tokens_user
    ON password_reset_tokens(user_id);
