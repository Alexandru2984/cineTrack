CREATE TABLE user_blocks (
    blocker_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (blocker_id, blocked_id),
    CONSTRAINT user_blocks_distinct_users CHECK (blocker_id <> blocked_id)
);

CREATE INDEX user_blocks_blocked_recent_idx
    ON user_blocks (blocked_id, created_at DESC, blocker_id);

CREATE FUNCTION enforce_user_block()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(
        hashtextextended('social-quota:' || LEAST(NEW.blocker_id, NEW.blocked_id)::text, 0)
    );
    PERFORM pg_advisory_xact_lock(
        hashtextextended('social-quota:' || GREATEST(NEW.blocker_id, NEW.blocked_id)::text, 0)
    );

    DELETE FROM follows
    WHERE
        (follower_id = NEW.blocker_id AND following_id = NEW.blocked_id)
        OR
        (follower_id = NEW.blocked_id AND following_id = NEW.blocker_id);

    DELETE FROM notifications
    WHERE
        (user_id = NEW.blocker_id AND actor_id = NEW.blocked_id)
        OR
        (user_id = NEW.blocked_id AND actor_id = NEW.blocker_id);

    RETURN NEW;
END;
$$;

CREATE TRIGGER user_blocks_enforce_relationship_boundary
    AFTER INSERT
    ON user_blocks
    FOR EACH ROW
    EXECUTE FUNCTION enforce_user_block();

CREATE TABLE user_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reporter_id UUID REFERENCES users(id) ON DELETE SET NULL,
    subject_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    target_type VARCHAR(16) NOT NULL,
    target_id UUID NOT NULL,
    reason VARCHAR(32) NOT NULL,
    details VARCHAR(1000),
    content_snapshot JSONB NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'open',
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT user_reports_known_target CHECK (
        target_type IN ('user', 'list')
    ),
    CONSTRAINT user_reports_known_reason CHECK (
        reason IN (
            'harassment',
            'hate',
            'threatening',
            'sexual',
            'child_safety',
            'impersonation',
            'spam',
            'privacy',
            'copyright',
            'other'
        )
    ),
    CONSTRAINT user_reports_known_status CHECK (
        status IN ('open', 'reviewing', 'actioned', 'dismissed')
    ),
    CONSTRAINT user_reports_resolution_consistent CHECK (
        (status IN ('open', 'reviewing') AND resolved_at IS NULL)
        OR
        (status IN ('actioned', 'dismissed') AND resolved_at IS NOT NULL)
    ),
    CONSTRAINT user_reports_snapshot_object CHECK (
        JSONB_TYPEOF(content_snapshot) = 'object'
    ),
    CONSTRAINT user_reports_distinct_users CHECK (
        reporter_id IS NULL
        OR subject_user_id IS NULL
        OR reporter_id <> subject_user_id
    )
);

CREATE UNIQUE INDEX user_reports_active_target_unique
    ON user_reports (reporter_id, target_type, target_id)
    WHERE reporter_id IS NOT NULL AND status IN ('open', 'reviewing');

CREATE INDEX user_reports_moderation_queue_idx
    ON user_reports (status, created_at, id)
    WHERE status IN ('open', 'reviewing');

CREATE INDEX user_reports_reporter_recent_idx
    ON user_reports (reporter_id, created_at DESC, id DESC)
    WHERE reporter_id IS NOT NULL;

CREATE INDEX user_reports_subject_recent_idx
    ON user_reports (subject_user_id, created_at DESC, id DESC)
    WHERE subject_user_id IS NOT NULL;

CREATE FUNCTION reject_blocked_follow_relationship()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(
        hashtextextended('social-quota:' || LEAST(NEW.follower_id, NEW.following_id)::text, 0)
    );
    PERFORM pg_advisory_xact_lock(
        hashtextextended('social-quota:' || GREATEST(NEW.follower_id, NEW.following_id)::text, 0)
    );

    IF EXISTS (
        SELECT 1
        FROM user_blocks block
        WHERE
            (block.blocker_id = NEW.follower_id AND block.blocked_id = NEW.following_id)
            OR
            (block.blocker_id = NEW.following_id AND block.blocked_id = NEW.follower_id)
    ) THEN
        RAISE EXCEPTION 'blocked users cannot have a follow relationship'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER follows_reject_blocked_relationship
    BEFORE INSERT OR UPDATE OF follower_id, following_id
    ON follows
    FOR EACH ROW
    EXECUTE FUNCTION reject_blocked_follow_relationship();

CREATE FUNCTION suppress_blocked_notification()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM user_blocks block
        WHERE
            (block.blocker_id = NEW.user_id AND block.blocked_id = NEW.actor_id)
            OR
            (block.blocker_id = NEW.actor_id AND block.blocked_id = NEW.user_id)
    ) THEN
        RETURN NULL;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER notifications_suppress_blocked_relationship
    BEFORE INSERT OR UPDATE OF user_id, actor_id
    ON notifications
    FOR EACH ROW
    EXECUTE FUNCTION suppress_blocked_notification();
