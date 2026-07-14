CREATE TABLE episode_plans (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    episode_id UUID NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, episode_id)
);

CREATE INDEX idx_episode_plans_user_created
    ON episode_plans (user_id, created_at DESC, episode_id);

CREATE INDEX idx_episode_plans_episode_id
    ON episode_plans (episode_id);

CREATE INDEX idx_episodes_air_date
    ON episodes (air_date, season_id, episode_number)
    WHERE air_date IS NOT NULL;

COMMENT ON TABLE episode_plans IS
    'Episodes a user explicitly saved to watch; watched state remains in watch_history.';
