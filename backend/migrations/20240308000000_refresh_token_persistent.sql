-- Whether a session should outlive the browser/app session it was created in.
--
-- "Keep me logged in" at sign-in decides this. TRUE (the default, and every row
-- that predates this column) means the web client is handed a persistent refresh
-- cookie and the mobile client keeps its refresh token in the device keychain, so
-- the session survives a restart. FALSE means a session-scoped cookie on the web
-- and an in-memory-only token on mobile, so closing the browser or the app ends
-- the session and the next visit signs in fresh.
--
-- The flag is carried forward on every rotation (see services::auth::refresh_token),
-- so the choice made once at sign-in holds for the life of the session rather than
-- resetting to the default on the first token refresh.
ALTER TABLE refresh_tokens
    ADD COLUMN persistent BOOLEAN NOT NULL DEFAULT TRUE;
