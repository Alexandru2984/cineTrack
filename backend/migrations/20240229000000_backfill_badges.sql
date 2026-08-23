-- Award badges for history that already exists.
--
-- Badges are recomputed when somebody records a watch. That is the right
-- trigger and it leaves out everyone who was already here: eleven accounts with
-- thirty-five thousand watches between them had no badges at all, and would
-- have had none until they happened to mark something new. A shelf that stays
-- empty for people with years of history is not a feature, it is a bug with a
-- UI.
--
-- The same four rules as `services::badges`, applied once to every account. It
-- is a copy, which is normally the thing to avoid — but a migration is frozen
-- at the moment it runs, and the alternative is calling application code from
-- SQL. If the rules change later, this file stays as the record of what was
-- awarded then; the service is what keeps them current.
INSERT INTO user_badges (user_id, badge_key, media_id, earned_at)
WITH runs AS (
    SELECT
        user_id,
        media_id,
        watched_at,
        COUNT(*) OVER (
            PARTITION BY user_id, media_id ORDER BY watched_at
            RANGE BETWEEN INTERVAL '24 hours' PRECEDING AND CURRENT ROW
        ) AS in_24h,
        COUNT(*) OVER (
            PARTITION BY user_id, media_id ORDER BY watched_at
            RANGE BETWEEN INTERVAL '48 hours' PRECEDING AND CURRENT ROW
        ) AS in_48h
    FROM watch_history
    WHERE episode_id IS NOT NULL
),
tiers (badge_key, window_hours, threshold) AS (
    VALUES ('marathon-3', 24, 3), ('marathon-5', 24, 5),
           ('marathon-10', 48, 10), ('marathon-20', 48, 20)
)
SELECT runs.user_id, tiers.badge_key, runs.media_id, MIN(runs.watched_at)
FROM runs
JOIN tiers
  ON (tiers.window_hours = 24 AND runs.in_24h >= tiers.threshold)
  OR (tiers.window_hours = 48 AND runs.in_48h >= tiers.threshold)
GROUP BY runs.user_id, tiers.badge_key, runs.media_id
ON CONFLICT (user_id, badge_key, COALESCE(media_id, '00000000-0000-0000-0000-000000000000'::uuid))
DO NOTHING;

INSERT INTO user_badges (user_id, badge_key, media_id, earned_at)
WITH prompt AS (
    SELECT
        history.user_id,
        seasons.media_id,
        history.watched_at,
        ROW_NUMBER() OVER (
            PARTITION BY history.user_id, seasons.media_id ORDER BY history.watched_at
        ) AS nth
    FROM watch_history history
    JOIN episodes ON episodes.id = history.episode_id
    JOIN seasons ON seasons.id = episodes.season_id
    JOIN media ON media.id = seasons.media_id
    WHERE episodes.air_date IS NOT NULL
      AND history.watched_at
          < episode_available_at(episodes.air_date, media.origin_country) + INTERVAL '24 hours'
),
tiers (badge_key, threshold) AS (
    VALUES ('same-day-3', 3), ('same-day-5', 5), ('same-day-10', 10), ('same-day-25', 25)
)
SELECT prompt.user_id, tiers.badge_key, prompt.media_id, prompt.watched_at
FROM prompt JOIN tiers ON tiers.threshold = prompt.nth
ON CONFLICT (user_id, badge_key, COALESCE(media_id, '00000000-0000-0000-0000-000000000000'::uuid))
DO NOTHING;

INSERT INTO user_badges (user_id, badge_key, media_id, earned_at)
WITH tracked AS (
    SELECT user_id, created_at,
        ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at) AS nth
    FROM user_media WHERE status = 'watching'
),
tiers (badge_key, threshold) AS (
    VALUES ('juggler-3', 3), ('juggler-8', 8), ('juggler-15', 15)
)
SELECT tracked.user_id, tiers.badge_key, NULL, tracked.created_at
FROM tracked JOIN tiers ON tiers.threshold = tracked.nth
ON CONFLICT (user_id, badge_key, COALESCE(media_id, '00000000-0000-0000-0000-000000000000'::uuid))
DO NOTHING;

INSERT INTO user_badges (user_id, badge_key, media_id, earned_at)
WITH counted AS (
    SELECT user_id, watched_at,
        ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY watched_at) AS nth
    FROM watch_history WHERE episode_id IS NOT NULL
),
tiers (badge_key, threshold) AS (
    VALUES ('watcher-50', 50), ('watcher-250', 250),
           ('watcher-1000', 1000), ('watcher-5000', 5000)
)
SELECT counted.user_id, tiers.badge_key, NULL, counted.watched_at
FROM counted JOIN tiers ON tiers.threshold = counted.nth
ON CONFLICT (user_id, badge_key, COALESCE(media_id, '00000000-0000-0000-0000-000000000000'::uuid))
DO NOTHING;
