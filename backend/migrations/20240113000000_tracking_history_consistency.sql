-- A completion date describes a completed title. Keeping it on any other
-- status makes status transitions and downstream statistics ambiguous.
UPDATE user_media
SET completed_at = NULL
WHERE status <> 'completed' AND completed_at IS NOT NULL;

ALTER TABLE user_media
    ADD CONSTRAINT user_media_completed_date_matches_status CHECK (
        status = 'completed' OR completed_at IS NULL
    );

-- Completion transitions check whether a movie or episode already has a
-- history event. These partial indexes keep that idempotency check bounded to
-- the relevant user's title instead of scanning their full history.
CREATE INDEX idx_watch_history_user_media_episode
    ON watch_history (user_id, media_id, episode_id)
    WHERE episode_id IS NOT NULL;

CREATE INDEX idx_watch_history_user_media_title
    ON watch_history (user_id, media_id)
    WHERE episode_id IS NULL;
