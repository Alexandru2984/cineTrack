CREATE TABLE release_schedule_sync_state (
    media_id UUID PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
    outcome VARCHAR(16) NOT NULL,
    consecutive_failures SMALLINT NOT NULL DEFAULT 0,
    last_attempt_at TIMESTAMPTZ NOT NULL,
    next_attempt_at TIMESTAMPTZ NOT NULL,
    last_success_at TIMESTAMPTZ,
    CONSTRAINT release_schedule_outcome_known CHECK (
        outcome IN ('success', 'not_found', 'transient', 'invalid')
    ),
    CONSTRAINT release_schedule_failures_bounded CHECK (
        consecutive_failures BETWEEN 0 AND 15
    ),
    CONSTRAINT release_schedule_success_shape CHECK (
        outcome <> 'success'
        OR (consecutive_failures = 0 AND last_success_at IS NOT NULL)
    ),
    CONSTRAINT release_schedule_attempt_order CHECK (
        last_success_at IS NULL OR last_success_at <= last_attempt_at
    )
);

CREATE INDEX idx_release_schedule_sync_due
    ON release_schedule_sync_state (next_attempt_at, media_id);
