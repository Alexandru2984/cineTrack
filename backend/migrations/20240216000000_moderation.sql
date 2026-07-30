CREATE TABLE moderators (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    granted_by VARCHAR(100) NOT NULL,
    CONSTRAINT moderators_grant_source_not_blank CHECK (BTRIM(granted_by) <> '')
);

ALTER TABLE user_reports
    ADD COLUMN moderated_by UUID REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN moderator_note VARCHAR(2000);

CREATE TABLE moderation_audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    report_id UUID REFERENCES user_reports(id) ON DELETE SET NULL,
    actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
    old_status VARCHAR(16) NOT NULL,
    new_status VARCHAR(16) NOT NULL,
    note VARCHAR(2000) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT moderation_audit_known_old_status CHECK (
        old_status IN ('open', 'reviewing', 'actioned', 'dismissed')
    ),
    CONSTRAINT moderation_audit_known_new_status CHECK (
        new_status IN ('open', 'reviewing', 'actioned', 'dismissed')
    ),
    CONSTRAINT moderation_audit_status_changed CHECK (old_status <> new_status),
    CONSTRAINT moderation_audit_note_not_blank CHECK (BTRIM(note) <> '')
);

CREATE INDEX moderation_audit_report_recent_idx
    ON moderation_audit_log (report_id, created_at DESC, id DESC);

CREATE INDEX moderation_audit_actor_recent_idx
    ON moderation_audit_log (actor_id, created_at DESC, id DESC)
    WHERE actor_id IS NOT NULL;

CREATE FUNCTION reject_moderation_audit_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    -- Foreign-key SET NULL actions must be able to detach a deleted report or
    -- account without rewriting the decision itself.
    IF TG_OP = 'UPDATE'
       AND NEW.id = OLD.id
       AND NEW.old_status = OLD.old_status
       AND NEW.new_status = OLD.new_status
       AND NEW.note = OLD.note
       AND NEW.created_at = OLD.created_at
       AND (
           NEW.report_id IS NOT DISTINCT FROM OLD.report_id
           OR (OLD.report_id IS NOT NULL AND NEW.report_id IS NULL)
       )
       AND (
           NEW.actor_id IS NOT DISTINCT FROM OLD.actor_id
           OR (OLD.actor_id IS NOT NULL AND NEW.actor_id IS NULL)
       )
       AND (
           NEW.report_id IS DISTINCT FROM OLD.report_id
           OR NEW.actor_id IS DISTINCT FROM OLD.actor_id
       ) THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'DELETE'
       AND OLD.created_at < NOW() - INTERVAL '730 days' THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'moderation audit records are append-only'
        USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER moderation_audit_append_only
    BEFORE UPDATE OR DELETE
    ON moderation_audit_log
    FOR EACH ROW
    EXECUTE FUNCTION reject_moderation_audit_mutation();

-- The runtime role cannot delete audit rows directly. This tightly scoped
-- owner function is its only retention path and cannot touch recent or active
-- moderation evidence.
CREATE FUNCTION prune_old_moderation_records(
    OUT moderation_audit BIGINT,
    OUT resolved_reports BIGINT
)
RETURNS RECORD
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    DELETE FROM public.moderation_audit_log
    WHERE created_at < NOW() - INTERVAL '730 days';
    GET DIAGNOSTICS moderation_audit = ROW_COUNT;

    DELETE FROM public.user_reports
    WHERE status IN ('actioned', 'dismissed')
      AND resolved_at < NOW() - INTERVAL '730 days';
    GET DIAGNOSTICS resolved_reports = ROW_COUNT;
END;
$$;

REVOKE ALL ON FUNCTION prune_old_moderation_records() FROM PUBLIC;
