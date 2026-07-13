ALTER TABLE media
    ADD COLUMN last_accessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX idx_media_last_accessed
    ON media (last_accessed_at, id);

CREATE TABLE provider_response_cache (
    provider VARCHAR(32) NOT NULL,
    cache_key CHAR(64) NOT NULL,
    endpoint VARCHAR(32) NOT NULL,
    payload JSONB NOT NULL,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    stale_until TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (provider, cache_key),
    CONSTRAINT provider_response_provider_shape CHECK (
        provider = btrim(provider)
        AND char_length(provider) BETWEEN 1 AND 32
    ),
    CONSTRAINT provider_response_endpoint_shape CHECK (
        endpoint = btrim(endpoint)
        AND char_length(endpoint) BETWEEN 1 AND 32
    ),
    CONSTRAINT provider_response_key_shape CHECK (cache_key ~ '^[0-9a-f]{64}$'),
    CONSTRAINT provider_response_expiry_order CHECK (
        fetched_at < expires_at
        AND expires_at <= stale_until
        AND stale_until <= fetched_at + INTERVAL '175 days'
    ),
    CONSTRAINT provider_response_payload_size CHECK (
        octet_length(payload::text) <= 2097152
    )
);

CREATE INDEX idx_provider_response_stale_until
    ON provider_response_cache (stale_until);

CREATE INDEX idx_provider_response_eviction
    ON provider_response_cache (fetched_at DESC, provider, cache_key);
