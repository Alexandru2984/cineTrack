-- New accounts must not be publicly discoverable before they confirm control
-- of their email address. Existing accounts keep their current visibility.
ALTER TABLE users
    ALTER COLUMN is_public SET DEFAULT FALSE;
