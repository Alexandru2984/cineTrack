-- Reactions on an episode.
--
-- Deliberately a fixed vocabulary rather than free text. Anything a user can
-- type is user-generated content, which on a public store listing brings
-- reporting, blocking and moderation obligations with it. A closed set carries
-- none of that, cannot carry a slur or a spoiler, and still gives the episode
-- page the social signal it was missing.
--
-- Only aggregate counts and the viewer's own choice are ever exposed, so a
-- private profile stays private without any extra visibility rules.

CREATE TABLE episode_reactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    episode_id UUID NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
    reaction VARCHAR(16) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- The vocabulary lives in the schema so a compromised or buggy caller
    -- cannot widen it into free text.
    CONSTRAINT episode_reactions_known_reaction CHECK (
        reaction IN ('loved', 'funny', 'shocked', 'sad', 'tense', 'bored')
    ),
    -- One reaction per person per episode; changing your mind replaces it.
    CONSTRAINT episode_reactions_one_per_user UNIQUE (user_id, episode_id)
);

-- The episode page always reads counts grouped by episode.
CREATE INDEX idx_episode_reactions_episode ON episode_reactions (episode_id, reaction);
-- Deleting an account clears its reactions through this.
CREATE INDEX idx_episode_reactions_user ON episode_reactions (user_id);
