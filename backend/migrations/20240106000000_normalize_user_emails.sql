-- Normalize existing emails to trimmed-lowercase so they match the new
-- register/login normalization. Safe for small datasets; if two rows differ
-- only by case this would violate the UNIQUE(email) constraint and must be
-- resolved manually first.
UPDATE users
SET email = lower(btrim(email))
WHERE email <> lower(btrim(email));
