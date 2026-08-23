-- Badges earned from watch history.
--
-- # Recomputed, never incremented
--
-- The obvious implementation is a counter bumped on every watch. It is a trap
-- here: this app imports history from TV Time in bulk, lets people delete
-- episodes, mark whole seasons at once, and correct mistakes. A counter drifts
-- from the history it claims to describe, and once it has drifted nobody can
-- say why somebody has a badge.
--
-- So this table holds only what is currently *true* of a user's history, and a
-- recompute rewrites it. Deleting an episode can take a badge away, which is
-- the honest behaviour: the badge was a statement about the history, and the
-- history changed.
--
-- # Why per-show rows
--
-- Marathons and quick watches happen to a *show*, not to an account: "you
-- watched five episodes of Silicon Valley in a day" is the fact. Storing the
-- show keeps that fact intact, so the UI can aggregate ("3 shows devoured")
-- without inventing the detail back. TV Time stored the same shape and then
-- showed all 228 of them at once, which is how a badge stops meaning anything.
CREATE TABLE user_badges (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    badge_key TEXT NOT NULL,
    -- NULL for badges about the account as a whole.
    media_id UUID REFERENCES media(id) ON DELETE CASCADE,
    -- When the history first satisfied the badge, not when the recompute ran.
    -- A recompute must not make old achievements look new.
    earned_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT user_badges_key_shape CHECK (badge_key ~ '^[a-z][a-z0-9-]{1,48}$')
);

-- One row per user, badge and show. `media_id` is nullable, and a plain unique
-- constraint would let a global badge be inserted twice because NULL is never
-- equal to NULL.
CREATE UNIQUE INDEX user_badges_unique
    ON user_badges (user_id, badge_key, COALESCE(media_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE INDEX user_badges_by_user ON user_badges (user_id, earned_at DESC);

-- The history queries behind the recompute scan a user's whole watch history
-- ordered by time. Without this they sort 35k rows per user per recompute.
CREATE INDEX IF NOT EXISTS watch_history_user_media_time
    ON watch_history (user_id, media_id, watched_at);

-- The volume family walks a whole account's history in time order, which the
-- index above cannot serve because it leads with the show.
CREATE INDEX IF NOT EXISTS watch_history_user_time
    ON watch_history (user_id, watched_at);
