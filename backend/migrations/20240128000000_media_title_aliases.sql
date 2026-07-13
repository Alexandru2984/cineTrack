ALTER TABLE media
    ADD COLUMN title_aliases_cached_at TIMESTAMPTZ;

CREATE TABLE media_title_aliases (
    media_id UUID NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    kind VARCHAR(16) NOT NULL,
    language_code VARCHAR(2) NOT NULL DEFAULT '',
    region_code VARCHAR(2) NOT NULL DEFAULT '',
    title VARCHAR(500) NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (media_id, kind, language_code, region_code, title),
    CONSTRAINT media_title_alias_kind_known CHECK (
        kind IN ('translation', 'alternative')
    ),
    CONSTRAINT media_title_alias_language_shape CHECK (
        language_code = '' OR language_code ~ '^[a-z]{2}$'
    ),
    CONSTRAINT media_title_alias_region_shape CHECK (
        region_code = '' OR region_code ~ '^[A-Z]{2}$'
    ),
    CONSTRAINT media_title_alias_title_shape CHECK (
        title = btrim(title)
        AND char_length(title) BETWEEN 1 AND 500
        AND title !~ '[[:cntrl:]]'
    )
);

CREATE INDEX idx_media_title_alias_trgm
    ON media_title_aliases USING GIN (lower(title) gin_trgm_ops);

CREATE INDEX idx_media_title_alias_locale
    ON media_title_aliases (language_code, kind, media_id, region_code);

COMMENT ON TABLE media_title_aliases IS
    'Bounded TMDB translations and alternative titles retained with hydrated media.';

COMMENT ON COLUMN media.title_aliases_cached_at IS
    'Last successful reconciliation of appended TMDB title aliases.';
