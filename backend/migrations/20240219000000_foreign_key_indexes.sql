-- Index the foreign keys that nothing else already covers.
--
-- Postgres does not index a referencing column on its own, and it has no skip
-- scan, so a composite index that merely contains the column does not help: the
-- cascade runs `DELETE FROM child WHERE fk = $1` per parent row and falls back
-- to a sequential scan. Every other reference into `media` and `episodes`
-- already carries a dedicated index for exactly this reason
-- (idx_user_media_media_id, idx_list_items_media_id, idx_episode_plans_episode_id,
-- idx_episode_reactions_episode); watch_history's episode reference was the one
-- left out, and it is the largest child of the four.
--
-- This matters most for the orphan media sweep. Pruning a cached title cascades
-- through seasons into episodes, and each of those episode deletions currently
-- scans the whole of watch_history.
CREATE INDEX idx_watch_history_episode_id
    ON watch_history (episode_id);

-- The remaining four all cascade from `users`, so they are walked whenever an
-- account is deleted. Account deletion has to complete reliably, and these
-- tables only grow, so index them before the scans get expensive rather than
-- after.
CREATE INDEX idx_lists_user_id
    ON lists (user_id);

CREATE INDEX idx_notifications_actor_id
    ON notifications (actor_id);

CREATE INDEX idx_oauth_accounts_user_id
    ON oauth_accounts (user_id);

CREATE INDEX idx_user_reports_moderated_by
    ON user_reports (moderated_by)
    WHERE moderated_by IS NOT NULL;
