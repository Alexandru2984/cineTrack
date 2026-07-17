CREATE TABLE push_devices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expo_push_token VARCHAR(255) NOT NULL UNIQUE,
    unregister_secret_hash VARCHAR(64) NOT NULL,
    platform VARCHAR(7) NOT NULL,
    app_version VARCHAR(32) NOT NULL,
    utc_offset_minutes SMALLINT NOT NULL,
    enabled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT push_devices_token_shape CHECK (
        expo_push_token ~ '^(Expo(nent)?PushToken)\[[A-Za-z0-9_-]{10,200}\]$'
    ),
    CONSTRAINT push_devices_secret_hash_shape CHECK (
        unregister_secret_hash ~ '^[a-f0-9]{64}$'
    ),
    CONSTRAINT push_devices_platform_known CHECK (platform IN ('android', 'ios')),
    CONSTRAINT push_devices_app_version_shape CHECK (
        app_version ~ '^[A-Za-z0-9._+-]{1,32}$'
    ),
    CONSTRAINT push_devices_utc_offset_bounded CHECK (
        utc_offset_minutes BETWEEN -840 AND 840
    )
);

CREATE INDEX push_devices_user_idx
    ON push_devices (user_id, last_seen_at DESC, id);

CREATE TABLE release_push_deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    push_device_id UUID NOT NULL REFERENCES push_devices(id) ON DELETE CASCADE,
    event_key VARCHAR(160) NOT NULL,
    event_kind VARCHAR(16) NOT NULL,
    title VARCHAR(120) NOT NULL,
    body VARCHAR(300) NOT NULL,
    tmdb_id INTEGER NOT NULL,
    media_type VARCHAR(10) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'pending',
    attempt_count SMALLINT NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ticket_id VARCHAR(100) UNIQUE,
    ticketed_at TIMESTAMPTZ,
    last_error VARCHAR(500),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT release_push_delivery_event_key_shape CHECK (
        event_key ~ '^(episode|movie):[a-f0-9-]{36}(:[0-9]{4}-[0-9]{2}-[0-9]{2})?$'
    ),
    CONSTRAINT release_push_delivery_kind_known CHECK (
        event_kind IN ('episode', 'movie')
    ),
    CONSTRAINT release_push_delivery_title_length CHECK (
        char_length(title) BETWEEN 1 AND 120
    ),
    CONSTRAINT release_push_delivery_body_length CHECK (
        char_length(body) BETWEEN 1 AND 300
    ),
    CONSTRAINT release_push_delivery_tmdb_positive CHECK (tmdb_id > 0),
    CONSTRAINT release_push_delivery_media_type_known CHECK (
        media_type IN ('movie', 'tv')
    ),
    CONSTRAINT release_push_delivery_status_known CHECK (
        status IN ('pending', 'ticketed', 'delivered', 'failed')
    ),
    CONSTRAINT release_push_delivery_attempts_bounded CHECK (
        attempt_count BETWEEN 0 AND 10
    ),
    CONSTRAINT release_push_delivery_ticket_shape CHECK (
        (status = 'ticketed' AND ticket_id IS NOT NULL AND ticketed_at IS NOT NULL)
        OR status <> 'ticketed'
    ),
    CONSTRAINT release_push_delivery_error_length CHECK (
        last_error IS NULL OR char_length(last_error) <= 500
    ),
    CONSTRAINT release_push_delivery_event_unique UNIQUE (push_device_id, event_key)
);

CREATE INDEX release_push_delivery_pending_idx
    ON release_push_deliveries (next_attempt_at, id)
    WHERE status = 'pending';

CREATE INDEX release_push_delivery_receipt_idx
    ON release_push_deliveries (ticketed_at, id)
    WHERE status = 'ticketed';
