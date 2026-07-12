DROP INDEX IF EXISTS idx_watch_history_user_date;

CREATE INDEX idx_watch_history_user_recent
    ON watch_history (user_id, watched_at DESC, id DESC)
    INCLUDE (media_id, episode_id);
