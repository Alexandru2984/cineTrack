ALTER TABLE users
    ADD CONSTRAINT users_username_not_blank CHECK (char_length(btrim(username)) BETWEEN 3 AND 50),
    ADD CONSTRAINT users_bio_length CHECK (bio IS NULL OR char_length(bio) <= 500),
    ADD CONSTRAINT users_avatar_url_shape CHECK (
        avatar_url IS NULL
        OR (
            char_length(avatar_url) <= 500
            AND (avatar_url LIKE 'http://%' OR avatar_url LIKE 'https://%')
        )
    );

ALTER TABLE media
    ADD CONSTRAINT media_tmdb_id_positive CHECK (tmdb_id > 0),
    ADD CONSTRAINT media_type_known CHECK (media_type IN ('movie', 'tv')),
    ADD CONSTRAINT media_runtime_non_negative CHECK (runtime_minutes IS NULL OR runtime_minutes >= 0),
    ADD CONSTRAINT media_vote_average_range CHECK (
        tmdb_vote_average IS NULL OR (tmdb_vote_average >= 0 AND tmdb_vote_average <= 10)
    );

ALTER TABLE seasons
    ADD CONSTRAINT seasons_number_non_negative CHECK (season_number >= 0),
    ADD CONSTRAINT seasons_episode_count_non_negative CHECK (episode_count IS NULL OR episode_count >= 0);

ALTER TABLE episodes
    ADD CONSTRAINT episodes_number_positive CHECK (episode_number > 0),
    ADD CONSTRAINT episodes_runtime_non_negative CHECK (runtime_minutes IS NULL OR runtime_minutes >= 0);

ALTER TABLE user_media
    ADD CONSTRAINT user_media_status_known CHECK (
        status IN ('watching', 'completed', 'plan_to_watch', 'dropped', 'on_hold')
    ),
    ADD CONSTRAINT user_media_review_length CHECK (review IS NULL OR char_length(review) <= 5000),
    ADD CONSTRAINT user_media_dates_ordered CHECK (
        started_at IS NULL OR completed_at IS NULL OR completed_at >= started_at
    );

ALTER TABLE lists
    ADD CONSTRAINT lists_name_not_blank CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
    ADD CONSTRAINT lists_description_length CHECK (
        description IS NULL OR char_length(description) <= 1000
    );
