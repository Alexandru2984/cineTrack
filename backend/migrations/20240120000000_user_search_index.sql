CREATE INDEX users_username_prefix_search_idx
    ON users (LOWER(username) text_pattern_ops);
