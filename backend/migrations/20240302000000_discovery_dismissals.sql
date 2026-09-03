-- Somewhere for "not interested" to live.
--
-- The recommender had no negative signal at all. Preferences were learned from
-- favourites, ratings, `completed`, `watching` and now the watchlist — every
-- one of them a way of saying yes. `dropped` exists as a status and no member
-- has ever used it, and nothing in the interface asks whether a recommendation
-- was wrong.
--
-- Not a `user_media` row. Dismissing a recommendation is not tracking it: a
-- dismissed title would show up in the library, in counts, and in the quota,
-- and "dropped" would claim the member started something they never opened.
CREATE TABLE discovery_dismissals (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    media_id UUID NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, media_id)
);

-- The recommender reads this per member on every discovery load, and the
-- primary key already serves that. This index serves the other direction:
-- account deletion cascades by user, and a dismissed title being removed from
-- the catalogue cascades by media.
CREATE INDEX idx_discovery_dismissals_media ON discovery_dismissals (media_id);
