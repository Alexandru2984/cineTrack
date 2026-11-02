-- Drop the inventory's discovery index, which nothing reads any more.
--
-- It ordered each media type's inventory by popularity for the discovery
-- lists. Those have read `media.popularity` since
-- 20240307000000_media_popularity.sql, and production last used the index on
-- 2026-09-12. It was still written to every day: the TMDB sync changes the
-- popularity of nearly every one of the 1.5 million rows, so each sync rewrote
-- 179 MB of index that no query reads.
--
-- Hydration orders the whole inventory by popularity, across both media types,
-- and keeps `idx_catalog_external_hydration_candidates` for that.

DROP INDEX idx_catalog_external_discover;
