-- Remove unused access_token column from oauth_accounts
-- OAuth is not implemented; storing plaintext tokens in schema invites future misuse
ALTER TABLE oauth_accounts DROP COLUMN IF EXISTS access_token;
