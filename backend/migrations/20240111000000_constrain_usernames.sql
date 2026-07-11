ALTER TABLE users DROP CONSTRAINT users_username_key;

CREATE UNIQUE INDEX users_username_case_insensitive_key
    ON users (LOWER(username));

ALTER TABLE users
    ADD CONSTRAINT users_username_url_safe CHECK (
        username ~ '^[A-Za-z0-9][A-Za-z0-9_-]{1,48}[A-Za-z0-9]$'
    );
