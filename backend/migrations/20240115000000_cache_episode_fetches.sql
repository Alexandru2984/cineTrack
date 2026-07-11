ALTER TABLE seasons
    ADD COLUMN episodes_cached_at TIMESTAMPTZ;

-- Existing episode rows came from a successful TMDB fetch. Treat them as warm
-- for one cache window so deploying this migration does not immediately
-- refetch every season users open.
UPDATE seasons s
SET episodes_cached_at = NOW()
WHERE EXISTS (
    SELECT 1 FROM episodes e WHERE e.season_id = s.id
);
