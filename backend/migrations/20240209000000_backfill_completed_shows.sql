-- Award the completed badge to shows that already earned it.
--
-- Nothing ever promoted `user_media.status` when the last episode was watched,
-- so accounts accumulated finished shows still sitting on 'watching' — the
-- episodes were individually ticked but the series never showed as complete.
-- The application now does this on every episode watch; this catches up the
-- rows that predate it.
--
-- Same rule as the application: only shows TMDB reports as finished qualify. A
-- returning series whose aired episodes are all watched is caught up, not
-- completed, and marking it would only be undone by next week's episode.

UPDATE user_media um
SET status = 'completed',
    -- The table requires completed_at >= started_at; GREATEST ignores a NULL
    -- start, so this stays valid for rows that never recorded one.
    completed_at = GREATEST(CURRENT_DATE, um.started_at),
    updated_at = NOW()
FROM media m
WHERE m.id = um.media_id
  AND m.media_type = 'tv'
  AND m.status IN ('Ended', 'Canceled')
  AND um.status <> 'completed'
  -- Specials (season 0) are optional viewing and never block completion.
  AND EXISTS (
      SELECT 1 FROM seasons s
      JOIN episodes e ON e.season_id = s.id
      WHERE s.media_id = m.id AND s.season_number > 0
  )
  AND NOT EXISTS (
      SELECT 1 FROM seasons s
      JOIN episodes e ON e.season_id = s.id
      WHERE s.media_id = m.id
        AND s.season_number > 0
        AND e.air_date IS NOT NULL
        AND e.air_date <= CURRENT_DATE
        AND NOT EXISTS (
            SELECT 1 FROM watch_history wh
            WHERE wh.user_id = um.user_id AND wh.episode_id = e.id
        )
  );
