CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE media
    ADD COLUMN metadata_level VARCHAR(16) NOT NULL DEFAULT 'detail',
    ADD CONSTRAINT media_metadata_level_known CHECK (
        metadata_level IN ('summary', 'detail')
    );

CREATE INDEX idx_media_title_trgm
    ON media USING GIN (lower(title) gin_trgm_ops);

CREATE INDEX idx_media_original_title_trgm
    ON media USING GIN (lower(original_title) gin_trgm_ops)
    WHERE original_title IS NOT NULL;
