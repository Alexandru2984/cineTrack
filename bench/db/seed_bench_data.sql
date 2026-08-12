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

-- Keep repeated runs deterministic. The runner creates accounts named from a
-- Unix timestamp; older runner accounts would otherwise accumulate and change
-- planner selectivity from one run to the next.
DELETE FROM users
WHERE id <> :user_id
  AND email ~ '^bench[0-9]+@mailbox[.]dev$';

-- A fresh disposable database contains only the account created by the
-- benchmark runner. Seed fixed background accounts so the measured user is a
-- realistic minority of shared tables even on the very first run.
INSERT INTO users (username, email, is_public, email_verified)
SELECT
  'bench-bg-' || lpad(n::text, 2, '0'),
  'bench-bg-' || lpad(n::text, 2, '0') || '@mailbox.dev',
  FALSE,
  TRUE
FROM generate_series(1, 30) AS n
ON CONFLICT DO NOTHING;

DELETE FROM watch_history history
USING users background
WHERE history.user_id = background.id
  AND background.email LIKE 'bench-bg-%@mailbox.dev';

DELETE FROM user_media tracked
USING users background
WHERE tracked.user_id = background.id
  AND background.email LIKE 'bench-bg-%@mailbox.dev';

-- Reset the social fixture as well. Background accounts persist between runs,
-- so leaving their old relationships or messages behind would make inbox
-- latency and unread counts depend on how often the benchmark was executed.
DELETE FROM direct_messages message
USING users background
WHERE background.email LIKE 'bench-bg-%@mailbox.dev'
  AND (message.sender_id = background.id OR message.recipient_id = background.id);

DELETE FROM follows relationship
USING users background
WHERE background.email LIKE 'bench-bg-%@mailbox.dev'
  AND (
    relationship.follower_id = background.id
    OR relationship.following_id = background.id
  );

-- Thirty mutual conversations for the measured account. The application and
-- database both require accepted follows in both directions before a message
-- can be inserted, so the performance fixture exercises the real invariant.
INSERT INTO follows (follower_id, following_id, status)
SELECT :user_id, background.id, 'accepted'
FROM users background
WHERE background.email LIKE 'bench-bg-%@mailbox.dev'
UNION ALL
SELECT background.id, :user_id, 'accepted'
FROM users background
WHERE background.email LIKE 'bench-bg-%@mailbox.dev'
ON CONFLICT (follower_id, following_id) DO UPDATE SET status = 'accepted';

-- A ring of mutual background relationships supplies traffic that does not
-- involve the measured account. This keeps its share below 10%, making the
-- planner choose as it would when one production user is a small slice of the
-- table instead of flattering the queries with a tiny fixture.
WITH ordered AS (
  SELECT
    id,
    row_number() OVER (ORDER BY email) AS position,
    count(*) OVER () AS total
  FROM users
  WHERE email LIKE 'bench-bg-%@mailbox.dev'
), pairs AS (
  SELECT source.id AS source_id, destination.id AS destination_id
  FROM ordered source
  JOIN ordered destination
    ON destination.position = CASE
      WHEN source.position = source.total THEN 1
      ELSE source.position + 1
    END
)
INSERT INTO follows (follower_id, following_id, status)
SELECT source_id, destination_id, 'accepted' FROM pairs
UNION ALL
SELECT destination_id, source_id, 'accepted' FROM pairs
ON CONFLICT (follower_id, following_id) DO UPDATE SET status = 'accepted';

-- One hundred messages per conversation: 3,000 rows for the benchmark user,
-- with a small recent unread tail. Bodies are deliberately non-empty and
-- representative so payload measurements include actual message content.
WITH peers AS (
  SELECT id, row_number() OVER (ORDER BY email) AS position
  FROM users
  WHERE email LIKE 'bench-bg-%@mailbox.dev'
), generated AS (
  SELECT
    CASE WHEN sequence % 2 = 0 THEN :user_id ELSE peer.id END AS sender_id,
    CASE WHEN sequence % 2 = 0 THEN peer.id ELSE :user_id END AS recipient_id,
    sequence,
    NOW() - ((peer.position * 100 + sequence) || ' minutes')::interval AS sent_at
  FROM peers peer
  CROSS JOIN generate_series(1, 100) AS sequence
)
INSERT INTO direct_messages (
  sender_id, recipient_id, client_nonce, body, read_at, created_at
)
SELECT
  sender_id,
  recipient_id,
  gen_random_uuid(),
  'Benchmark message ' || sequence || ': representative direct-message payload.',
  CASE
    WHEN recipient_id = :user_id AND sequence > 90 THEN NULL
    ELSE sent_at + INTERVAL '1 second'
  END,
  sent_at
FROM generated;

-- A thousand messages on every background edge: 30,000 more rows that give
-- Postgres enough selectivity to expose missing indexes or sequential scans.
WITH ordered AS (
  SELECT
    id,
    row_number() OVER (ORDER BY email) AS position,
    count(*) OVER () AS total
  FROM users
  WHERE email LIKE 'bench-bg-%@mailbox.dev'
), pairs AS (
  SELECT source.id AS source_id, destination.id AS destination_id, source.position
  FROM ordered source
  JOIN ordered destination
    ON destination.position = CASE
      WHEN source.position = source.total THEN 1
      ELSE source.position + 1
    END
), generated AS (
  SELECT
    CASE WHEN sequence % 2 = 0 THEN source_id ELSE destination_id END AS sender_id,
    CASE WHEN sequence % 2 = 0 THEN destination_id ELSE source_id END AS recipient_id,
    sequence,
    NOW() - ((position * 1000 + sequence) || ' minutes')::interval AS sent_at
  FROM pairs
  CROSS JOIN generate_series(1, 1000) AS sequence
)
INSERT INTO direct_messages (
  sender_id, recipient_id, client_nonce, body, read_at, created_at
)
SELECT
  sender_id,
  recipient_id,
  gen_random_uuid(),
  'Background benchmark message ' || sequence,
  sent_at + INTERVAL '1 second',
  sent_at
FROM generated;

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

-- Shared-table background for the library list plans. Each synthetic account
-- has the same realistic library shape as the measured account, keeping the
-- measured user's share below 10% without relying on previous benchmark runs.
INSERT INTO user_media (user_id, media_id, status, rating, is_favorite, started_at, completed_at, created_at, updated_at)
SELECT
  background.id,
  m.id,
  st.status,
  CASE WHEN st.status = 'completed' THEN 5 + (m.tmdb_id % 6) ELSE NULL END,
  (m.tmdb_id % 11) = 0,
  DATE '2023-01-01' + (m.tmdb_id % 400),
  CASE WHEN st.status = 'completed' THEN DATE '2024-06-01' + (m.tmdb_id % 300) ELSE NULL END,
  NOW() - ((m.tmdb_id % 500) || ' days')::interval,
  NOW() - ((m.tmdb_id % 90) || ' days')::interval
FROM users background
CROSS JOIN media m
CROSS JOIN LATERAL (
  SELECT CASE
    WHEN m.tmdb_id % 10 < 5 THEN 'completed'
    WHEN m.tmdb_id % 10 < 8 THEN 'plan_to_watch'
    WHEN m.tmdb_id % 10 = 8 THEN 'watching'
    ELSE 'on_hold'
  END AS status
) st
WHERE background.email LIKE 'bench-bg-%@mailbox.dev'
  AND m.tmdb_id BETWEEN 9000001 AND 9000320;

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

-- Keep one actively watched show incomplete and recent. The broad history
-- above intentionally completes its first 60 shows, which is useful for stats
-- but used to leave the Up Next benchmark measuring an empty response.
UPDATE user_media tracked
SET status = 'watching', started_at = CURRENT_DATE - 1, updated_at = NOW()
FROM media m
WHERE tracked.user_id = :user_id
  AND tracked.media_id = m.id
  AND m.tmdb_id = 9000068;

INSERT INTO watch_history (user_id, media_id, episode_id, watched_at)
SELECT :user_id, m.id, ep.id, NOW() - INTERVAL '1 hour'
FROM media m
JOIN seasons se ON se.media_id = m.id AND se.season_number = 1
JOIN episodes ep ON ep.season_id = se.id AND ep.episode_number = 1
WHERE m.tmdb_id = 9000068;

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
  SELECT id
  FROM users
  WHERE email LIKE 'bench-bg-%@mailbox.dev'
  ORDER BY email
)
INSERT INTO watch_history (user_id, media_id, episode_id, watched_at)
SELECT o.id, p.id, NULL, NOW() - ((n % 1000) || ' days')::interval
FROM others o
CROSS JOIN generate_series(1, 2000) AS n
JOIN pool p ON p.idx = n % 240;

SELECT
  COUNT(*) FILTER (WHERE user_id = :user_id) * 10 >= COUNT(*)
    AS invalid_user_media_share
FROM user_media
\gset
\if :invalid_user_media_share
  \echo 'benchmark seed error: measured user owns at least 10% of user_media'
  \quit 1
\endif

SELECT
  COUNT(*) FILTER (WHERE user_id = :user_id) * 10 >= COUNT(*)
    AS invalid_watch_history_share
FROM watch_history
\gset
\if :invalid_watch_history_share
  \echo 'benchmark seed error: measured user owns at least 10% of watch_history'
  \quit 1
\endif

SELECT NOT EXISTS (
  SELECT 1
  FROM media m
  JOIN user_media tracked
    ON tracked.media_id = m.id
   AND tracked.user_id = :user_id
   AND tracked.status = 'watching'
  JOIN watch_history history
    ON history.media_id = m.id
   AND history.user_id = :user_id
   AND history.watched_at >= NOW() - INTERVAL '30 days'
  JOIN seasons se ON se.media_id = m.id AND se.season_number = 1
  JOIN episodes next_episode
    ON next_episode.season_id = se.id
   AND next_episode.episode_number = 2
  WHERE m.tmdb_id = 9000068
    AND NOT EXISTS (
      SELECT 1
      FROM watch_history watched
      WHERE watched.user_id = :user_id
        AND watched.episode_id = next_episode.id
    )
) AS invalid_up_next_seed
\gset
\if :invalid_up_next_seed
  \echo 'benchmark seed error: Up Next fixture is missing or already completed'
  \quit 1
\endif

COMMIT;

ANALYZE media;
ANALYZE seasons;
ANALYZE episodes;
ANALYZE user_media;
ANALYZE watch_history;
ANALYZE follows;
ANALYZE direct_messages;

SELECT 'user_media' AS table, count(*) FROM user_media WHERE user_id = :user_id
UNION ALL SELECT 'watch_history', count(*) FROM watch_history WHERE user_id = :user_id
UNION ALL SELECT 'direct_messages', count(*) FROM direct_messages
  WHERE sender_id = :user_id OR recipient_id = :user_id
UNION ALL SELECT 'episodes', count(*) FROM episodes
UNION ALL SELECT 'media', count(*) FROM media;

SELECT
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE user_id = :user_id) / NULLIF(COUNT(*), 0),
    2
  ) AS benchmark_user_percent,
  COUNT(*) AS total_rows,
  'user_media' AS table
FROM user_media
UNION ALL
SELECT
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE user_id = :user_id) / NULLIF(COUNT(*), 0),
    2
  ),
  COUNT(*),
  'watch_history'
FROM watch_history
UNION ALL
SELECT
  ROUND(
    100.0 * COUNT(*) FILTER (
      WHERE sender_id = :user_id OR recipient_id = :user_id
    ) / NULLIF(COUNT(*), 0),
    2
  ),
  COUNT(*),
  'direct_messages'
FROM direct_messages;
