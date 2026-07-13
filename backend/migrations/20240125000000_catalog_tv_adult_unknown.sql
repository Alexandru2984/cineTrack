ALTER TABLE catalog_external_ids
    ALTER COLUMN adult DROP NOT NULL;

ALTER TABLE catalog_external_ids
    ADD CONSTRAINT catalog_external_movie_adult_known CHECK (
        media_type <> 'movie' OR adult IS NOT NULL
    );

ALTER TABLE catalog_external_ids_staging
    ALTER COLUMN adult DROP NOT NULL;

ALTER TABLE catalog_external_ids_staging
    ADD CONSTRAINT catalog_staging_movie_adult_known CHECK (
        media_type <> 'movie' OR adult IS NOT NULL
    );

COMMENT ON COLUMN catalog_external_ids.adult IS
    'NULL means the TMDB daily TV export did not provide an adult flag.';
