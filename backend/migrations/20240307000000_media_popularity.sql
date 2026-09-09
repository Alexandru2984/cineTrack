-- Carry `popularity` on `media`, so discovery stops joining the 620 MB
-- inventory to read one number.
--
-- Discovery is the slowest thing this database does: 620 ms on average and
-- 2.9 s at worst, and 56 seconds of the total across every variant. The reason
-- is one join. `media` holds about 6,800 rows worth showing — detail metadata,
-- a poster — and every one of them has to be matched against
-- `catalog_external_ids`, which holds 1.46 million, purely to order by
-- popularity.
--
-- For films the planner does that with a nested loop and it costs 47 ms. For
-- series it estimates 380 rows, gets 5,274, and switches to a hash join that
-- reads the whole TV partition of the index — 229,200 entries. Measured, as
-- buffers touched, which is the part that does not depend on what happens to be
-- cached:
--
--   as it is (hash join)      5,889
--   extended statistics       5,883   (the estimate is not what is wrong)
--   forced nested loop        5,090   (still probes the big table 5,274 times)
--   popularity on media       1,459
--
-- Only the last one is a real change, because only the last one stops touching
-- the big table at all. The rewritten query was checked against the original on
-- production data: same 500 rows, same order, nothing in either that was not in
-- the other.
--
-- `real`, matching the source column exactly, so nothing is rounded on the way
-- across.
ALTER TABLE media ADD COLUMN popularity real;

-- Every row that has an inventory entry today. `adult` and `video` are part of
-- the discovery filter, and excluding them here keeps that decision in one
-- place rather than repeating it in the query.
UPDATE media
SET popularity = ids.popularity
FROM catalog_external_ids ids
WHERE ids.media_type = media.media_type
  AND ids.tmdb_id = media.tmdb_id
  AND NOT ids.adult
  AND NOT ids.video;

-- Keeping it true, without depending on which row is written first.
--
-- The first attempt filled the column from a BEFORE INSERT trigger on `media`
-- and left refreshes to the nightly sync. It worked in production, where the
-- inventory is a complete TMDB export that always precedes hydration — and it
-- broke three existing tests immediately, because a fixture inserts `media`
-- before the inventory and has no reason not to.
--
-- That is worth more than a test failure. A denormalisation whose correctness
-- depends on insert ordering is a trap for whoever writes the next fixture or
-- the next feature, and it repairs itself only once a day. So the column is
-- reconciled from both sides instead, and ordering stops mattering.

-- One row, as it is written: the ordinary path, where the inventory is already
-- there and discovery should show the title at once rather than tomorrow.
CREATE OR REPLACE FUNCTION media_fill_popularity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.popularity IS NULL THEN
        SELECT ids.popularity INTO NEW.popularity
        FROM catalog_external_ids ids
        WHERE ids.media_type = NEW.media_type
          AND ids.tmdb_id = NEW.tmdb_id
          AND NOT ids.adult
          AND NOT ids.video;
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION media_fill_popularity() IS
    'Fills media.popularity from the catalogue inventory as a row is inserted, so a title hydrated between syncs is not missing from discovery until the next one.';

CREATE TRIGGER media_fill_popularity_on_insert
    BEFORE INSERT ON media
    FOR EACH ROW
    EXECUTE FUNCTION media_fill_popularity();

-- And the other side, which is what makes the order irrelevant: whenever the
-- inventory changes, every `media` row is brought back into agreement with it.
--
-- FOR EACH STATEMENT, which is the whole reason this is affordable. The daily
-- sync moves 1.46 million rows in one INSERT; a row-level trigger would fire
-- 1.46 million times. This fires once per statement and reconciles the 7,000
-- rows of `media` — a join on the inventory's primary key, and `IS DISTINCT
-- FROM` so only rows that actually moved are written.
CREATE OR REPLACE FUNCTION media_reconcile_popularity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    UPDATE media
    SET popularity = ids.popularity
    FROM catalog_external_ids ids
    WHERE ids.media_type = media.media_type
      AND ids.tmdb_id = media.tmdb_id
      AND NOT ids.adult
      AND NOT ids.video
      AND media.popularity IS DISTINCT FROM ids.popularity;

    -- A title the export dropped, or that turned adult or video, has to lose
    -- its copy too: otherwise it keeps surfacing in discovery on a number
    -- nothing backs any more.
    UPDATE media
    SET popularity = NULL
    WHERE media.popularity IS NOT NULL
      AND NOT EXISTS (
          SELECT 1
          FROM catalog_external_ids ids
          WHERE ids.media_type = media.media_type
            AND ids.tmdb_id = media.tmdb_id
            AND NOT ids.adult
            AND NOT ids.video
      );

    RETURN NULL;
END;
$$;

COMMENT ON FUNCTION media_reconcile_popularity() IS
    'Brings media.popularity back into agreement with the catalogue inventory after any statement that changed it. Statement-level: the daily sync writes 1.46M rows in one statement.';

CREATE TRIGGER catalog_external_ids_reconcile_media_popularity
    AFTER INSERT OR UPDATE OR DELETE ON catalog_external_ids
    FOR EACH STATEMENT
    EXECUTE FUNCTION media_reconcile_popularity();

COMMENT ON COLUMN media.popularity IS
    'Copy of catalog_external_ids.popularity, reconciled from both sides by trigger. NULL means no non-adult, non-video inventory row — which is exactly what the old inner join excluded.';
