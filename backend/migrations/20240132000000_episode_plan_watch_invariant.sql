CREATE FUNCTION public.clear_episode_plan_after_watch()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF NEW.episode_id IS NOT NULL THEN
        DELETE FROM episode_plans
        WHERE user_id = NEW.user_id AND episode_id = NEW.episode_id;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER watch_history_clears_episode_plan
AFTER INSERT ON watch_history
FOR EACH ROW
EXECUTE FUNCTION public.clear_episode_plan_after_watch();

COMMENT ON FUNCTION public.clear_episode_plan_after_watch() IS
    'Keeps watched history authoritative across API, completion and import paths.';
