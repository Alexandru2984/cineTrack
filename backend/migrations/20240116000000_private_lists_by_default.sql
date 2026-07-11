-- A list must be explicitly published. Existing lists keep their visibility;
-- this changes only future inserts that rely on the database default.
ALTER TABLE lists
    ALTER COLUMN is_public SET DEFAULT false;
