TRUNCATE catalog_external_ids_staging;

UPDATE catalog_external_ids
SET adult = FALSE,
    updated_at = NOW()
WHERE media_type = 'tv' AND adult IS NULL;

ALTER TABLE catalog_external_ids
    ALTER COLUMN adult SET NOT NULL,
    DROP CONSTRAINT catalog_external_movie_adult_known;

ALTER TABLE catalog_external_ids_staging
    ALTER COLUMN adult SET NOT NULL,
    DROP CONSTRAINT catalog_staging_movie_adult_known,
    ADD COLUMN title VARCHAR(500) NOT NULL,
    ADD CONSTRAINT catalog_staging_title_shape CHECK (
        title = btrim(title)
        AND char_length(title) BETWEEN 1 AND 500
        AND title !~ '[[:cntrl:]]'
    );

CREATE TABLE catalog_external_titles (
    media_type VARCHAR(10) NOT NULL,
    tmdb_id INTEGER NOT NULL,
    title VARCHAR(500) NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (media_type, tmdb_id),
    FOREIGN KEY (media_type, tmdb_id)
        REFERENCES catalog_external_ids(media_type, tmdb_id)
        ON DELETE CASCADE,
    CONSTRAINT catalog_title_media_type_known CHECK (media_type IN ('movie', 'tv')),
    CONSTRAINT catalog_title_tmdb_id_positive CHECK (tmdb_id > 0),
    CONSTRAINT catalog_title_shape CHECK (
        title = btrim(title)
        AND char_length(title) BETWEEN 1 AND 500
        AND title !~ '[[:cntrl:]]'
    )
);

CREATE INDEX idx_catalog_external_title_trgm
    ON catalog_external_titles USING GIN (lower(title) gin_trgm_ops);

COMMENT ON COLUMN catalog_external_ids.adult IS
    'Standard TMDB exports are non-adult; adult IDs are published separately.';

COMMENT ON TABLE catalog_external_titles IS
    'Original titles revalidated by each successful TMDB daily export sync.';
