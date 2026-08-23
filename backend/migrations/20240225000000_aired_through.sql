-- One definition of when an episode counts as having aired.
--
-- `episodes.air_date` is a bare DATE meaning the local calendar date of the
-- first broadcast on the *origin* network — no time, no zone. A US drama shown
-- on Sunday at 21:00 Eastern carries the Sunday date and reaches Romania on
-- Monday at 04:00.
--
-- The application treated that date as available from its own midnight, and in
-- one path from the date the *client* reported, which a caller chooses. Between
-- them an episode could be offered as watchable thirty-nine hours before anyone
-- outside the origin country could watch it, and the codebase disagreed with
-- itself: some queries used the server's date, others the server's date plus
-- fourteen hours. A show could therefore appear in Up Next and be refused by
-- the route that marks it watched.
--
-- The rule is that an episode has aired once its air date has fully elapsed in
-- UTC. For prime-time US television that lands at 20:00 Eastern, within an hour
-- of the broadcast itself.
--
-- It lives here rather than in the application so that the twelve queries which
-- need it stay plain SQL, and so no future query can quietly invent a
-- thirteenth answer.
CREATE OR REPLACE FUNCTION aired_through()
RETURNS date
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
    SELECT ((NOW() AT TIME ZONE 'UTC')::date - 1)
$$;

COMMENT ON FUNCTION aired_through() IS
    'Latest episode air_date that has fully elapsed in UTC. See the migration for why.';
