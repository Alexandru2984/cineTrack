-- Library pages are ordered by recency, with and without a status filter.
-- Include the stable id tie-breaker so the index remains useful if pagination
-- moves from offsets to cursors.
CREATE INDEX idx_user_media_user_updated
    ON user_media (user_id, updated_at DESC, id DESC);

CREATE INDEX idx_user_media_user_status_updated
    ON user_media (user_id, status, updated_at DESC, id DESC);

-- The new indexes retain these indexes' left-most lookup prefixes while also
-- satisfying the list order, so keeping both pairs only adds write overhead.
DROP INDEX idx_user_media_user_id;
DROP INDEX idx_user_media_status;
