-- Covering index for the stats endpoints. /stats/me runs several per-user scans
-- of watch_history (episode count, total watch-time, streak dates). Without a
-- covering index these do a bitmap heap scan of every one of the user's rows;
-- INCLUDE-ing episode_id/media_id/watched_at lets them run as index-only scans.
-- Benchmarked at 100 full-history users: /stats/me throughput 19 -> 157 req/s,
-- episode-count query 175ms -> 6ms (zero heap fetches).
CREATE INDEX IF NOT EXISTS idx_watch_history_user_covering
    ON watch_history (user_id) INCLUDE (episode_id, media_id, watched_at);
