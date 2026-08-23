-- Where a show comes from, so "has it aired" can stop guessing.
--
-- `aired_through()` treats an air date as elapsed at UTC midnight. That is
-- close for prime-time US television and wrong for everywhere else: an episode
-- broadcast at 23:00 in Tokyo has aired ten hours before UTC agrees, and one
-- broadcast at 21:00 in Los Angeles has not aired for four hours after.
--
-- TMDB gives the origin country. It does not give an air *time* for television,
-- and nobody does, so the honest reading of a bare air date is "some time
-- during that day where the network is". The end of that day is therefore the
-- first moment the episode has certainly gone out.
--
-- The error direction changes, and that is the point. Before: up to a day
-- early, promising something the viewer cannot watch. Now: never early, at most
-- a few hours late, which is the difference between a queue that lies and one
-- that lags.
ALTER TABLE media
    ADD COLUMN origin_country CHAR(2);

ALTER TABLE media
    ADD CONSTRAINT media_origin_country_shape CHECK (
        origin_country IS NULL OR origin_country ~ '^[A-Z]{2}$'
    );

-- A representative zone per country, not a complete tz database.
--
-- Countries spanning several zones resolve to the one their national networks
-- broadcast from, because that is what an air date on TMDB actually reflects: a
-- US show carries its Eastern broadcast date whether or not Hawaii has seen it.
-- Picking the westernmost zone instead would be defensible and would make every
-- US show three hours later than it needs to be.
--
-- Unlisted countries fall back to UTC, which is exactly the behaviour this
-- replaces, so an unmapped country is no worse off than before.
CREATE OR REPLACE FUNCTION country_timezone(country CHAR(2))
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
    SELECT CASE country
        WHEN 'US' THEN 'America/New_York'
        WHEN 'CA' THEN 'America/Toronto'
        WHEN 'MX' THEN 'America/Mexico_City'
        WHEN 'BR' THEN 'America/Sao_Paulo'
        WHEN 'AR' THEN 'America/Argentina/Buenos_Aires'
        WHEN 'CL' THEN 'America/Santiago'
        WHEN 'CO' THEN 'America/Bogota'
        WHEN 'GB' THEN 'Europe/London'
        WHEN 'IE' THEN 'Europe/Dublin'
        WHEN 'FR' THEN 'Europe/Paris'
        WHEN 'DE' THEN 'Europe/Berlin'
        WHEN 'ES' THEN 'Europe/Madrid'
        WHEN 'IT' THEN 'Europe/Rome'
        WHEN 'PT' THEN 'Europe/Lisbon'
        WHEN 'NL' THEN 'Europe/Amsterdam'
        WHEN 'BE' THEN 'Europe/Brussels'
        WHEN 'CH' THEN 'Europe/Zurich'
        WHEN 'AT' THEN 'Europe/Vienna'
        WHEN 'PL' THEN 'Europe/Warsaw'
        WHEN 'CZ' THEN 'Europe/Prague'
        WHEN 'HU' THEN 'Europe/Budapest'
        WHEN 'RO' THEN 'Europe/Bucharest'
        WHEN 'GR' THEN 'Europe/Athens'
        WHEN 'SE' THEN 'Europe/Stockholm'
        WHEN 'NO' THEN 'Europe/Oslo'
        WHEN 'DK' THEN 'Europe/Copenhagen'
        WHEN 'FI' THEN 'Europe/Helsinki'
        WHEN 'IS' THEN 'Atlantic/Reykjavik'
        WHEN 'TR' THEN 'Europe/Istanbul'
        WHEN 'RU' THEN 'Europe/Moscow'
        WHEN 'UA' THEN 'Europe/Kyiv'
        WHEN 'IL' THEN 'Asia/Jerusalem'
        WHEN 'AE' THEN 'Asia/Dubai'
        WHEN 'IN' THEN 'Asia/Kolkata'
        WHEN 'CN' THEN 'Asia/Shanghai'
        WHEN 'HK' THEN 'Asia/Hong_Kong'
        WHEN 'TW' THEN 'Asia/Taipei'
        WHEN 'JP' THEN 'Asia/Tokyo'
        WHEN 'KR' THEN 'Asia/Seoul'
        WHEN 'TH' THEN 'Asia/Bangkok'
        WHEN 'PH' THEN 'Asia/Manila'
        WHEN 'ID' THEN 'Asia/Jakarta'
        WHEN 'AU' THEN 'Australia/Sydney'
        WHEN 'NZ' THEN 'Pacific/Auckland'
        WHEN 'ZA' THEN 'Africa/Johannesburg'
        WHEN 'NG' THEN 'Africa/Lagos'
        WHEN 'EG' THEN 'Africa/Cairo'
        ELSE 'UTC'
    END
$$;

-- The first moment an episode has certainly aired.
--
-- Returns NULL for an episode with no date, which every caller already treats
-- as "do not withhold this" — the show is usually finished and the missing date
-- is a gap in TMDB rather than an episode still to come.
CREATE OR REPLACE FUNCTION episode_available_at(air_date date, origin_country CHAR(2))
RETURNS timestamptz
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
    SELECT CASE
        WHEN air_date IS NULL THEN NULL
        ELSE ((air_date + 1)::timestamp AT TIME ZONE country_timezone(origin_country))
    END
$$;

CREATE OR REPLACE FUNCTION episode_has_aired(air_date date, origin_country CHAR(2))
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
    SELECT air_date IS NULL OR NOW() >= episode_available_at(air_date, origin_country)
$$;

COMMENT ON FUNCTION episode_has_aired(date, CHAR(2)) IS
    'Whether an episode has certainly aired, by the end of its air date where the origin network is.';

-- Nothing calls `aired_through()` any more: every episode check goes through
-- the origin-aware pair above. Dropped rather than left behind, because an
-- unused function that still answers a plausible question is an invitation for
-- the next query to use it and quietly reintroduce the UTC assumption.
DROP FUNCTION IF EXISTS aired_through();
