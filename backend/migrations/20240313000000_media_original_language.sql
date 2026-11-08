-- The language a title was made in, as TMDB reports it (ISO 639-1).
--
-- The library's Anime filter is Animation made in Japanese. `origin_country`
-- cannot answer that: it is only stored for series, so an anime film such as
-- Jujutsu Kaisen 0 has none, and a country is a weaker signal than the
-- language anyway (a Japanese co-production dubbed from English is not
-- anime; a Japanese-language film made elsewhere usually is).
--
-- Filled by every detail refresh from here on. Rows refreshed before this
-- column existed stay NULL until their next refresh, which is at most 30 days
-- for anything in a library.
ALTER TABLE media
    ADD COLUMN original_language VARCHAR(2),
    ADD CONSTRAINT media_original_language_shape
        CHECK (original_language ~ '^[a-z]{2}$');
