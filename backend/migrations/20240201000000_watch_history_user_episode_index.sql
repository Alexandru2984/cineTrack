CREATE INDEX idx_watch_history_user_episode
    ON watch_history (user_id, episode_id)
    WHERE episode_id IS NOT NULL;
