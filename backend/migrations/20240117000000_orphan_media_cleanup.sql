-- Orphan cleanup looks up references by media_id. The original composite
-- indexes are user/list-first and cannot support these anti-joins efficiently.
CREATE INDEX IF NOT EXISTS idx_user_media_media_id
    ON user_media (media_id);

CREATE INDEX IF NOT EXISTS idx_watch_history_media_id
    ON watch_history (media_id);

CREATE INDEX IF NOT EXISTS idx_list_items_media_id
    ON list_items (media_id);

CREATE INDEX IF NOT EXISTS idx_media_cache_age
    ON media (tmdb_cached_at, id);
