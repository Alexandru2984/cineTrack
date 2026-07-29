-- A user-visible, owner-scoped security timeline. Rows are append-only from the
-- application and deliberately bounded both by age and by per-account count.
CREATE TABLE security_activity (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event_type VARCHAR(40) NOT NULL CHECK (
        event_type IN (
            'account_registered',
            'login_succeeded',
            'password_changed',
            'password_reset',
            'email_change_requested',
            'email_changed',
            'two_factor_enabled',
            'two_factor_disabled',
            'session_revoked',
            'all_sessions_revoked',
            'account_data_exported'
        )
    ),
    user_agent VARCHAR(512),
    ip_address VARCHAR(45),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_security_activity_user_created
    ON security_activity (user_id, created_at DESC, id DESC);
