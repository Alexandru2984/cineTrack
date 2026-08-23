-- Re-sealing the private key under a new password is its own event.
--
-- Folding it into `encryption_keys_published` would be convenient and wrong:
-- publishing means the key changed and every peer should re-check a safety
-- number, while this means only the secret that opens it changed. Somebody
-- reading their own security log needs to be able to tell those apart, because
-- one of them is what a key substitution would look like.
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
            'encryption_backup_rewrapped'
        )
    );
