DROP INDEX IF EXISTS follows_pending_requests_idx;
DROP INDEX IF EXISTS follows_accepted_followers_idx;

CREATE INDEX follows_pending_requests_idx
    ON follows (following_id, created_at DESC, follower_id)
    WHERE status = 'pending';

CREATE INDEX follows_accepted_followers_idx
    ON follows (following_id, created_at DESC, follower_id)
    WHERE status = 'accepted';

CREATE INDEX follows_accepted_following_idx
    ON follows (follower_id, created_at DESC, following_id)
    WHERE status = 'accepted';
