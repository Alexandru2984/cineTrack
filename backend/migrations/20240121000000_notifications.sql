CREATE TABLE notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    actor_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind VARCHAR(32) NOT NULL,
    read_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT notifications_known_kind CHECK (
        kind IN ('follow_request', 'follow_accepted', 'new_follower')
    ),
    CONSTRAINT notifications_distinct_users CHECK (user_id <> actor_id),
    CONSTRAINT notifications_relationship_event_key UNIQUE (user_id, actor_id, kind)
);

CREATE INDEX notifications_user_recent_idx
    ON notifications (user_id, created_at DESC, id DESC)
    INCLUDE (actor_id, kind, read_at);

CREATE INDEX notifications_user_unread_idx
    ON notifications (user_id, created_at DESC, id DESC)
    WHERE read_at IS NULL;
