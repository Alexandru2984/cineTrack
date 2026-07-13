CREATE TABLE catalog_external_ids (
    media_type VARCHAR(10) NOT NULL,
    tmdb_id INTEGER NOT NULL,
    adult BOOLEAN NOT NULL,
    video BOOLEAN NOT NULL,
    popularity REAL NOT NULL,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (media_type, tmdb_id),
    CONSTRAINT catalog_external_media_type_known CHECK (media_type IN ('movie', 'tv')),
    CONSTRAINT catalog_external_tmdb_id_positive CHECK (tmdb_id > 0),
    CONSTRAINT catalog_external_popularity_non_negative CHECK (popularity >= 0)
);

CREATE INDEX idx_catalog_external_discover
    ON catalog_external_ids (media_type, popularity DESC, tmdb_id)
    WHERE NOT adult AND NOT video;

CREATE UNLOGGED TABLE catalog_external_ids_staging (
    media_type VARCHAR(10) NOT NULL,
    tmdb_id INTEGER NOT NULL,
    adult BOOLEAN NOT NULL,
    video BOOLEAN NOT NULL,
    popularity REAL NOT NULL,
    PRIMARY KEY (media_type, tmdb_id),
    CONSTRAINT catalog_staging_media_type_known CHECK (media_type IN ('movie', 'tv')),
    CONSTRAINT catalog_staging_tmdb_id_positive CHECK (tmdb_id > 0),
    CONSTRAINT catalog_staging_popularity_non_negative CHECK (popularity >= 0)
);

CREATE TABLE catalog_sync_state (
    provider VARCHAR(32) PRIMARY KEY,
    export_date DATE NOT NULL,
    movie_rows INTEGER NOT NULL,
    tv_rows INTEGER NOT NULL,
    movie_sha256 CHAR(64) NOT NULL,
    tv_sha256 CHAR(64) NOT NULL,
    movie_object_key TEXT NOT NULL,
    tv_object_key TEXT NOT NULL,
    completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT catalog_sync_provider_shape CHECK (
        provider = btrim(provider) AND char_length(provider) BETWEEN 1 AND 32
    ),
    CONSTRAINT catalog_sync_counts_positive CHECK (movie_rows > 0 AND tv_rows > 0),
    CONSTRAINT catalog_sync_hash_shapes CHECK (
        movie_sha256 ~ '^[0-9a-f]{64}$' AND tv_sha256 ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT catalog_sync_object_key_lengths CHECK (
        char_length(movie_object_key) BETWEEN 1 AND 500
        AND char_length(tv_object_key) BETWEEN 1 AND 500
    )
);
