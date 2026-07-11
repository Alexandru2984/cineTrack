ALTER TABLE follows
    ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'accepted',
    ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD CONSTRAINT follows_status_known CHECK (status IN ('pending', 'accepted'));

ALTER TABLE follows ALTER COLUMN status DROP DEFAULT;

CREATE INDEX follows_pending_requests_idx
    ON follows (following_id, created_at DESC)
    WHERE status = 'pending';

CREATE INDEX follows_accepted_followers_idx
    ON follows (following_id, created_at DESC)
    WHERE status = 'accepted';
