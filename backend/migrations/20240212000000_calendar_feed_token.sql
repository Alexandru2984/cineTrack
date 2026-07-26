-- Subscribable iCal calendar feed.
--
-- Calendar apps (Google/Apple/Outlook) poll a plain URL and cannot send a
-- bearer token, so the URL itself carries a per-user secret. Only the SHA-256
-- hash of that secret is stored — the plaintext is shown to the user once and
-- never persisted — mirroring how refresh and password-reset tokens are kept.
-- NULL means the feed is disabled; regenerating replaces the hash, which
-- instantly revokes the old URL.
ALTER TABLE users
    ADD COLUMN calendar_feed_token_hash CHAR(64);

-- Partial unique index: the feed handler looks a user up by token hash, and
-- most rows are NULL (feed not enabled).
CREATE UNIQUE INDEX idx_users_calendar_feed_token_hash
    ON users (calendar_feed_token_hash)
    WHERE calendar_feed_token_hash IS NOT NULL;
