-- Let a streaming release count from the start of its air date.
--
-- The availability rule says an episode has aired once its air date is over
-- where the show is made, because TMDB gives a date and no time, and the end of
-- that day is the first moment a broadcast has certainly gone out. For
-- television that costs a few hours at most.
--
-- For a show that only streams it costs most of a day. The streaming services
-- release at midnight Pacific on the air date or earlier (Apple TV, the evening
-- before). On 2026-11-01 Dexter: Resurrection's second season was out on
-- Paramount+ with Showtime, and Up Next held it back until 05:00 UTC the next
-- day.
--
-- So a show whose networks are all streaming services is available from
-- midnight Pacific on its air date. Midnight Pacific is the latest of those
-- release times, so the rule is still never early. A show that also has a
-- broadcaster keeps the old rule: an anime that airs on Japanese television and
-- streams afterwards carries the broadcast's date, and midnight Pacific is
-- 16:00 in Tokyo, hours before it airs.
--
-- The flag is filled in from TMDB's network list on each metadata refresh,
-- like `origin_country`; until then a show keeps the old, later rule.

ALTER TABLE media
    ADD COLUMN streaming_only BOOLEAN NOT NULL DEFAULT false;

-- Replaced rather than overloaded: a two-argument version left behind would
-- still answer the question, with the old answer, for whoever calls it next.
DROP FUNCTION episode_has_aired(date, CHAR(2));
DROP FUNCTION episode_available_at(date, CHAR(2));

CREATE FUNCTION episode_available_at(
    air_date date,
    origin_country CHAR(2),
    streaming_only boolean
)
RETURNS timestamptz
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
    SELECT CASE
        WHEN air_date IS NULL THEN NULL
        WHEN streaming_only THEN (air_date::timestamp AT TIME ZONE 'America/Los_Angeles')
        ELSE ((air_date + 1)::timestamp AT TIME ZONE public.country_timezone(origin_country))
    END
$$;

-- Still inlinable: no SET clause, and the cheap comparison still comes first.
-- It holds for both rules, since either one puts availability within a day of
-- the air date.
CREATE FUNCTION episode_has_aired(
    air_date date,
    origin_country CHAR(2),
    streaming_only boolean
)
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
    SELECT air_date IS NULL
        OR air_date < (NOW() AT TIME ZONE 'UTC')::date - 1
        OR NOW() >= CASE
            WHEN streaming_only THEN (air_date::timestamp AT TIME ZONE 'America/Los_Angeles')
            ELSE ((air_date + 1)::timestamp AT TIME ZONE public.country_timezone(origin_country))
        END
$$;

COMMENT ON FUNCTION episode_has_aired(date, CHAR(2), boolean) IS
    'Whether an episode has certainly aired: from midnight Pacific on its air date for a streaming-only show, otherwise by the end of its air date where the origin network is. Inlinable: no SET clause.';
