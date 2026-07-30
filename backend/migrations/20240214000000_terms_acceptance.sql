ALTER TABLE users
    ADD COLUMN terms_accepted_version VARCHAR(32),
    ADD COLUMN terms_accepted_at TIMESTAMPTZ,
    ADD CONSTRAINT users_terms_acceptance_consistent
        CHECK (
            (terms_accepted_version IS NULL AND terms_accepted_at IS NULL)
            OR
            (terms_accepted_version IS NOT NULL AND terms_accepted_at IS NOT NULL)
        );

CREATE TABLE user_terms_acceptances (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    terms_version VARCHAR(32) NOT NULL,
    accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, terms_version),
    CONSTRAINT user_terms_acceptances_version_not_blank
        CHECK (BTRIM(terms_version) <> '')
);

CREATE INDEX idx_user_terms_acceptances_accepted_at
    ON user_terms_acceptances(accepted_at);
