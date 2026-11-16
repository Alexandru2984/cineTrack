-- The site moved from vazute.micutu.com to vazute.com.
--
-- Avatars served through the backend's asset proxy are stored as absolute URLs,
-- and those were written on the old host. Left alone they break twice: the web
-- app's Content-Security-Policy allows images from its own origin only, so they
-- stop showing, and an upload no longer recognises the URL it replaces as one
-- of ours, so the old object is never deleted.
--
-- Only that exact prefix is rewritten. A deployment on any other host has no
-- such rows and is unaffected.
UPDATE users
SET avatar_url = 'https://vazute.com/api/assets/'
    || substr(avatar_url, length('https://vazute.micutu.com/api/assets/') + 1)
WHERE avatar_url LIKE 'https://vazute.micutu.com/api/assets/%';
