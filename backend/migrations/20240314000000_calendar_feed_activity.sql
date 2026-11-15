-- Minting or removing a calendar feed URL is a security event.
--
-- The URL is a bearer credential answered without a session, so it outlives
-- every session on the account. Somebody who held the account for a moment
-- could mint one and keep reading the owner's titles and air dates; the owner
-- now sees that in the timeline they already review.
ALTER TABLE security_activity
    DROP CONSTRAINT security_activity_event_type_check;

ALTER TABLE security_activity
    ADD CONSTRAINT security_activity_event_type_check CHECK (
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
            'account_data_exported',
            'encryption_keys_published',
            'encryption_backup_rewrapped',
            'calendar_feed_enabled',
            'calendar_feed_disabled'
        )
    );
