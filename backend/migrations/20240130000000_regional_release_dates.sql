CREATE TABLE user_calendar_preferences (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    country_code VARCHAR(2) NOT NULL DEFAULT 'RO',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT user_calendar_country_code_shape CHECK (
        country_code ~ '^[A-Z]{2}$'
    )
);

CREATE TABLE media_release_dates (
    media_id UUID NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    country_code VARCHAR(2) NOT NULL,
    release_type SMALLINT NOT NULL,
    release_date DATE NOT NULL,
    PRIMARY KEY (media_id, country_code, release_type, release_date),
    CONSTRAINT media_release_country_code_shape CHECK (
        country_code ~ '^[A-Z]{2}$'
    ),
    CONSTRAINT media_release_type_known CHECK (release_type BETWEEN 1 AND 6)
);

CREATE INDEX idx_media_release_dates_calendar
    ON media_release_dates (country_code, release_date, media_id, release_type);

COMMENT ON COLUMN media_release_dates.release_type IS
    'TMDB release type: 1 premiere, 2 limited theatrical, 3 theatrical, 4 digital, 5 physical, 6 TV.';
