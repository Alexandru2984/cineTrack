-- Read the most popular detailed titles of one type in index order.
--
-- Title pages list twelve related titles, genre hubs sixty, and discovery
-- starts from the most popular titles of each type: all three filter `media`
-- to detailed rows with a popularity and take the top of
-- `ORDER BY popularity DESC, tmdb_id`. With no index for that order each one
-- read and sorted every row of the table. Title pages are what crawlers fetch,
-- about 700 times a day, at 52 ms each in production.
--
-- On a copy of production's 19,609 rows, related titles for Drama went from
-- 56 ms to 1.3 ms with this index. A rare genre walks further down the order
-- before it has twelve, so Documentary came down from 86 ms to 15 ms.

CREATE INDEX idx_media_detail_popularity
    ON media (media_type, popularity DESC, tmdb_id)
    WHERE metadata_level = 'detail' AND popularity IS NOT NULL;
