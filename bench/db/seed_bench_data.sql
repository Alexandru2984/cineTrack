-- Seed a heavy-but-plausible library for one benchmark account.
--
-- Benchmarks against an empty database measure nothing: every list query returns
-- zero rows, the planner picks sequential scans over tiny tables, and payloads
-- come back a few hundred bytes. The volumes here describe a long-time user —
-- 320 tracked titles, ~4.8k episodes, ~3.8k watches over three years — so the
-- planner sees realistic selectivity and mobile payloads are measured at the
-- size they actually reach a phone.
--
-- Invoked as: psql -v user_id="'<uuid>'" -f seed_bench_data.sql
-- Re-running is safe: it clears this account's rows first.

\set ON_ERROR_STOP on

BEGIN;

DELETE FROM watch_history WHERE user_id = :user_id;
DELETE FROM user_media WHERE user_id = :user_id;

-- 320 titles: 80 shows, 240 films. Offset into a tmdb_id range that the real
-- catalogue will not collide with.
INSERT INTO media (tmdb_id, media_type, title, overview, poster_path, backdrop_path,
                   release_date, status, genres, runtime_minutes, tmdb_vote_average)
SELECT
  9000000 + n,
  CASE WHEN n <= 80 THEN 'tv' ELSE 'movie' END,
  'Bench Title ' || n,
  repeat('Synopsis sentence for benchmark payload sizing. ', 6),
  '/bench' || n || '.jpg',
  '/benchbd' || n || '.jpg',
  DATE '2005-01-01' + (n * 17),
  CASE WHEN n <= 80 THEN 'Returning Series' ELSE 'Released' END,
  '[{"id":18,"name":"Drama"},{"id":10765,"name":"Sci-Fi & Fantasy"}]'::jsonb,
  CASE WHEN n <= 80 THEN 45 ELSE 100 + (n % 60) END,
  5.0 + ((n % 50) / 10.0)
FROM generate_series(1, 320) AS n
ON CONFLICT DO NOTHING;

-- Five seasons per show.
INSERT INTO seasons (media_id, season_number, name, episode_count, air_date, episodes_cached_at)
SELECT m.id, s, 'Season ' || s, 12, DATE '2010-01-01' + (s * 365), NOW()
FROM media m
CROSS JOIN generate_series(1, 5) AS s
WHERE m.tmdb_id BETWEEN 9000001 AND 9000080 AND m.media_type = 'tv'
ON CONFLICT DO NOTHING;

-- Twelve episodes per season: 80 * 5 * 12 = 4800 rows.
INSERT INTO episodes (season_id, episode_number, name, overview, runtime_minutes, air_date, still_path)
SELECT
  se.id,
  e,
  'Episode ' || e,
  repeat('Episode synopsis text used to size list payloads. ', 3),
  42,
  se.air_date + (e * 7),
  '/still' || e || '.jpg'
FROM seasons se
JOIN media m ON m.id = se.media_id
CROSS JOIN generate_series(1, 12) AS e
WHERE m.tmdb_id BETWEEN 9000001 AND 9000080
ON CONFLICT DO NOTHING;

-- Tracked library, weighted the way a real one is: mostly completed, a long
-- tail of plan_to_watch, a handful in flight.
INSERT INTO user_media (user_id, media_id, status, rating, is_favorite, started_at, completed_at, created_at, updated_at)
SELECT
  :user_id,
  m.id,
  st.status,
  CASE WHEN st.status = 'completed' THEN 5 + (m.tmdb_id % 6) ELSE NULL END,
  (m.tmdb_id % 11) = 0,
  DATE '2023-01-01' + (m.tmdb_id % 400),
  CASE WHEN st.status = 'completed' THEN DATE '2024-06-01' + (m.tmdb_id % 300) ELSE NULL END,
  NOW() - ((m.tmdb_id % 500) || ' days')::interval,
  NOW() - ((m.tmdb_id % 90) || ' days')::interval
FROM media m
CROSS JOIN LATERAL (
  SELECT CASE
    WHEN m.tmdb_id % 10 < 5 THEN 'completed'
    WHEN m.tmdb_id % 10 < 8 THEN 'plan_to_watch'
    WHEN m.tmdb_id % 10 = 8 THEN 'watching'
    ELSE 'on_hold'
  END AS status
) st
WHERE m.tmdb_id BETWEEN 9000001 AND 9000320;

-- Episode watches spread across three years so the heatmap, streaks and the
-- Wrapped year filter all have to discriminate by date rather than scan.
INSERT INTO watch_history (user_id, media_id, episode_id, watched_at)
SELECT
  :user_id,
  m.id,
  ep.id,
  (NOW() - ((row_number() OVER ()) % 1095 || ' days')::interval)
    - ((row_number() OVER ()) % 24 || ' hours')::interval
FROM episodes ep
JOIN seasons se ON se.id = ep.season_id
JOIN media m ON m.id = se.media_id
WHERE m.tmdb_id BETWEEN 9000001 AND 9000060;

-- Film watches, so movie-only paths are not empty either.
INSERT INTO watch_history (user_id, media_id, episode_id, watched_at)
SELECT
  :user_id,
  m.id,
  NULL,
  NOW() - ((m.tmdb_id % 900) || ' days')::interval
FROM media m
WHERE m.tmdb_id BETWEEN 9000081 AND 9000320;

-- Background rows belonging to *other* accounts.
--
-- Without these the benchmark account owns most of watch_history, and Postgres
-- correctly prefers a sequential scan — which is the opposite of what it does
-- in production, where one user is a sliver of the table. Skipping this step
-- makes the planner behave unlike production and turns every index check into
-- a false alarm. Target: the bench account holds well under 10% of the rows.
WITH pool AS (
  SELECT id, (row_number() OVER (ORDER BY tmdb_id) - 1) AS idx
  FROM media WHERE tmdb_id BETWEEN 9000081 AND 9000320
), others AS (
  SELECT id FROM users WHERE id <> :user_id LIMIT 30
)
INSERT INTO watch_history (user_id, media_id, episode_id, watched_at)
SELECT o.id, p.id, NULL, NOW() - ((n % 1000) || ' days')::interval
FROM others o
CROSS JOIN generate_series(1, 2000) AS n
JOIN pool p ON p.idx = n % 240;

COMMIT;

ANALYZE media;
ANALYZE seasons;
ANALYZE episodes;
ANALYZE user_media;
ANALYZE watch_history;

SELECT 'user_media' AS table, count(*) FROM user_media WHERE user_id = :user_id
UNION ALL SELECT 'watch_history', count(*) FROM watch_history WHERE user_id = :user_id
UNION ALL SELECT 'episodes', count(*) FROM episodes
UNION ALL SELECT 'media', count(*) FROM media;
