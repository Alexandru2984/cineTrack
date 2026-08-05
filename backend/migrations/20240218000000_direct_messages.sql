CREATE TABLE direct_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_nonce UUID NOT NULL,
    body TEXT NOT NULL,
    read_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT direct_messages_distinct_users CHECK (sender_id <> recipient_id),
    CONSTRAINT direct_messages_body_length CHECK (
        CHAR_LENGTH(body) BETWEEN 1 AND 2000
    ),
    CONSTRAINT direct_messages_read_after_creation CHECK (
        read_at IS NULL OR read_at >= created_at
    ),
    CONSTRAINT direct_messages_sender_nonce_unique UNIQUE (sender_id, client_nonce)
);

CREATE INDEX direct_messages_sender_recent_idx
    ON direct_messages (sender_id, created_at DESC, id DESC);

CREATE INDEX direct_messages_recipient_recent_idx
    ON direct_messages (recipient_id, created_at DESC, id DESC);

CREATE INDEX direct_messages_conversation_recent_idx
    ON direct_messages (
        LEAST(sender_id, recipient_id),
        GREATEST(sender_id, recipient_id),
        created_at DESC,
        id DESC
    );

CREATE INDEX direct_messages_unread_idx
    ON direct_messages (recipient_id, created_at DESC, id DESC)
    WHERE read_at IS NULL;

-- Keep the mutual-follow and block boundary as a database invariant as well as
-- an application check. The advisory locks are the same deterministic locks
-- used by follow/unfollow/block routes, closing their transaction race window.
CREATE FUNCTION enforce_direct_message_boundary()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(
        hashtextextended('social-quota:' || LEAST(NEW.sender_id, NEW.recipient_id)::text, 0)
    );
    PERFORM pg_advisory_xact_lock(
        hashtextextended('social-quota:' || GREATEST(NEW.sender_id, NEW.recipient_id)::text, 0)
    );

    IF EXISTS (
        SELECT 1
        FROM public.user_blocks block
        WHERE
            (block.blocker_id = NEW.sender_id AND block.blocked_id = NEW.recipient_id)
            OR
            (block.blocker_id = NEW.recipient_id AND block.blocked_id = NEW.sender_id)
    ) OR NOT (
        EXISTS (
            SELECT 1
            FROM public.follows
            WHERE follower_id = NEW.sender_id
              AND following_id = NEW.recipient_id
              AND status = 'accepted'
        )
        AND EXISTS (
            SELECT 1
            FROM public.follows
            WHERE follower_id = NEW.recipient_id
              AND following_id = NEW.sender_id
              AND status = 'accepted'
        )
    ) THEN
        RAISE EXCEPTION 'direct messages require an unblocked mutual follow relationship'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER direct_messages_enforce_relationship_boundary
    BEFORE INSERT OR UPDATE OF sender_id, recipient_id
    ON direct_messages
    FOR EACH ROW
    EXECUTE FUNCTION enforce_direct_message_boundary();

CREATE FUNCTION enforce_direct_message_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF NEW.sender_id IS DISTINCT FROM OLD.sender_id
        OR NEW.recipient_id IS DISTINCT FROM OLD.recipient_id
        OR NEW.client_nonce IS DISTINCT FROM OLD.client_nonce
        OR NEW.body IS DISTINCT FROM OLD.body
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
        RAISE EXCEPTION 'direct message content and identity are immutable'
            USING ERRCODE = '23514';
    END IF;

    IF OLD.read_at IS NOT NULL AND NEW.read_at IS DISTINCT FROM OLD.read_at THEN
        RAISE EXCEPTION 'direct message read state cannot be reversed'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER direct_messages_enforce_immutability
    BEFORE UPDATE
    ON direct_messages
    FOR EACH ROW
    EXECUTE FUNCTION enforce_direct_message_immutability();

ALTER TABLE user_reports
    DROP CONSTRAINT user_reports_known_target;

ALTER TABLE user_reports
    ADD CONSTRAINT user_reports_known_target CHECK (
        target_type IN ('user', 'list', 'message')
    );
