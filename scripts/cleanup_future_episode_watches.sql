-- Remove watch history for episodes that have not aired yet.
--
-- These rows were written before the guard that rejects future completions was
-- deployed: a bulk "watched through" against a currently-airing show recorded
-- every scheduled episode, including ones months away. The application refuses
-- this now, so nothing new can arrive here; this only clears what predates it.
--
-- Deliberately narrow: only rows whose episode has a known air date strictly in
-- the future. An episode with no air date is left alone — that usually means
-- the catalogue is incomplete rather than the watch being wrong.
--
-- Run inside a transaction and read the two SELECTs before committing:
--   docker exec -i cinetrack-db-1 psql -U cinetrack_user -d cinetrack \
--     -1 -f - < scripts/cleanup_future_episode_watches.sql

\set ON_ERROR_STOP on

-- What is about to go, so it can be checked before the delete runs.
SELECT u.username, m.title, s.season_number, e.episode_number, e.air_date
FROM watch_history wh
JOIN users u ON u.id = wh.user_id
JOIN episodes e ON e.id = wh.episode_id
JOIN seasons s ON s.id = e.season_id
JOIN media m ON m.id = s.media_id
WHERE e.air_date > CURRENT_DATE
ORDER BY u.username, m.title, s.season_number, e.episode_number;

DELETE FROM watch_history wh
USING episodes e
WHERE wh.episode_id = e.id
  AND e.air_date IS NOT NULL
  AND e.air_date > CURRENT_DATE;

-- Must come back empty.
SELECT count(*) AS future_watches_remaining
FROM watch_history wh
JOIN episodes e ON e.id = wh.episode_id
WHERE e.air_date > CURRENT_DATE;
