-- Make the availability check fast enough to sit in a hot query.
--
-- `episode_has_aired` shipped as a `STABLE` function with `SET search_path`.
-- Both choices were defensible in isolation and together they cost 123x on the
-- most-used screen in the product: Up Next went from 110ms to 13.6 seconds on
-- an account tracking 455 shows. Measured on production data, not a guess.
--
-- Two separate causes, and both matter.
--
-- # A function with a SET clause cannot be inlined
--
-- Postgres inlines a simple SQL function into the calling query, letting the
-- planner optimise the body as if it had been written there. A `SET` clause
-- makes that impossible — the function needs its own execution context — so
-- every one of 28,000 rows paid a full function call.
--
-- The clause was there to stop a hostile schema shadowing `country_timezone`.
-- That is a real attack against a role that can create objects, and the role
-- this runs as cannot: `provision_db_role.sh` revokes creation on `public` and
-- grants only what is needed. The inner call is schema-qualified explicitly,
-- which removes the ambiguity the clause was pinning.
--
-- # Most episodes do not need the expensive answer
--
-- The time-zone conversion is only interesting near the boundary. An episode
-- whose air date is more than one whole day past has aired everywhere on earth,
-- because the widest offset in use is under fourteen hours. So the cheap
-- comparison settles all but the last two days, and the exact answer is
-- computed for the handful of rows where it can change anything.
--
-- Ordering matters: the cheap test comes first so the expensive one is never
-- reached for old episodes.

CREATE OR REPLACE FUNCTION country_timezone(country CHAR(2))
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
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

CREATE OR REPLACE FUNCTION episode_available_at(air_date date, origin_country CHAR(2))
RETURNS timestamptz
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
    SELECT CASE
        WHEN air_date IS NULL THEN NULL
        ELSE ((air_date + 1)::timestamp AT TIME ZONE public.country_timezone(origin_country))
    END
$$;

CREATE OR REPLACE FUNCTION episode_has_aired(air_date date, origin_country CHAR(2))
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
    SELECT air_date IS NULL
        -- Aired everywhere: the widest offset in use is under a full day, so an
        -- air date more than one day past cannot still be in the future for
        -- anybody. Cheap, indexable, and true for all but the last two days.
        OR air_date < (NOW() AT TIME ZONE 'UTC')::date - 1
        -- Only near the boundary does the origin network's clock matter.
        OR NOW() >= ((air_date + 1)::timestamp AT TIME ZONE public.country_timezone(origin_country))
$$;

COMMENT ON FUNCTION episode_has_aired(date, CHAR(2)) IS
    'Whether an episode has certainly aired, by the end of its air date where the origin network is. Inlinable: no SET clause, so the planner can optimise it into the calling query.';
