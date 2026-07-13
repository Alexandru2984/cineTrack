CREATE TABLE catalog_hydration_state (
    media_type VARCHAR(10) NOT NULL,
    tmdb_id INTEGER NOT NULL,
    outcome VARCHAR(16) NOT NULL,
    consecutive_failures SMALLINT NOT NULL DEFAULT 0,
    last_attempt_at TIMESTAMPTZ NOT NULL,
    next_attempt_at TIMESTAMPTZ NOT NULL,
    last_success_at TIMESTAMPTZ,
    PRIMARY KEY (media_type, tmdb_id),
    FOREIGN KEY (media_type, tmdb_id)
        REFERENCES catalog_external_ids(media_type, tmdb_id)
        ON DELETE CASCADE,
    CONSTRAINT catalog_hydration_outcome_known CHECK (
        outcome IN ('success', 'not_found', 'transient', 'invalid')
    ),
    CONSTRAINT catalog_hydration_failures_bounded CHECK (
        consecutive_failures BETWEEN 0 AND 15
    ),
    CONSTRAINT catalog_hydration_success_shape CHECK (
        outcome <> 'success'
        OR (consecutive_failures = 0 AND last_success_at IS NOT NULL)
    ),
    CONSTRAINT catalog_hydration_attempt_order CHECK (
        next_attempt_at >= last_attempt_at
        AND (last_success_at IS NULL OR last_success_at <= last_attempt_at)
    )
);

CREATE INDEX idx_catalog_hydration_retry
    ON catalog_hydration_state (next_attempt_at, media_type, tmdb_id);

CREATE INDEX idx_catalog_external_hydration_candidates
    ON catalog_external_ids (popularity DESC, media_type, tmdb_id)
    WHERE NOT adult AND NOT video;
