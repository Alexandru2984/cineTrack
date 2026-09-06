-- Stop keeping a copy of the identity that the account password opens.
--
-- H01 of the September 2026 audit, and the root of M01 and M16 with it. The
-- backup was wrapped twice: once under a key derived from the account password,
-- and once under a key derived from a recovery code. The recovery code is
-- generated on the client and never sent here. The password is sent here on
-- every sign-in — so the first copy is one this server can open, and the
-- product's claim that it cannot read messages was not true of the protocol.
--
-- Removing the password copy is what makes the claim true, rather than making
-- it expensive to break. It also removes the coupling that produced the other
-- two findings: a wrap that does not depend on the password has nothing to
-- re-seal when the password changes (M01) and nothing for a stolen token to
-- overwrite that a recovery code cannot restore (M16).
--
-- The cost is real: restoring on a new device now needs the recovery code.
-- That is what every end-to-end encrypted product asks for, and it is the
-- honest price of the guarantee.
--
-- Done in two steps so nobody is stranded. This migration makes the password
-- copy optional; it does not delete anyone's. New setups stop writing one, and
-- an account that still has one keeps it until its owner has saved a fresh
-- recovery code — because somebody who set up encryption and lost their code is
-- relying on that copy right now, and dropping it here would lock them out of
-- their own history.
ALTER TABLE user_key_backups
    ALTER COLUMN password_wrapped_key DROP NOT NULL,
    ALTER COLUMN password_kdf_salt DROP NOT NULL,
    ALTER COLUMN password_kdf_memory_kib DROP NOT NULL,
    ALTER COLUMN password_kdf_iterations DROP NOT NULL,
    ALTER COLUMN password_kdf_parallelism DROP NOT NULL;

-- The recovery half borrowed the password half's cost parameters, which cannot
-- survive the password half going away. Backfilled from them, so existing
-- backups describe exactly the cost they were actually wrapped at.
ALTER TABLE user_key_backups
    ADD COLUMN IF NOT EXISTS recovery_kdf_memory_kib INTEGER,
    ADD COLUMN IF NOT EXISTS recovery_kdf_iterations INTEGER,
    ADD COLUMN IF NOT EXISTS recovery_kdf_parallelism INTEGER;

UPDATE user_key_backups
SET recovery_kdf_memory_kib = COALESCE(recovery_kdf_memory_kib, password_kdf_memory_kib),
    recovery_kdf_iterations = COALESCE(recovery_kdf_iterations, password_kdf_iterations),
    recovery_kdf_parallelism = COALESCE(recovery_kdf_parallelism, password_kdf_parallelism)
WHERE recovery_kdf_memory_kib IS NULL;

ALTER TABLE user_key_backups
    ALTER COLUMN recovery_kdf_memory_kib SET NOT NULL,
    ALTER COLUMN recovery_kdf_iterations SET NOT NULL,
    ALTER COLUMN recovery_kdf_parallelism SET NOT NULL;

-- The password copy is all-or-nothing: a row must carry every part of it or
-- none. A half-written one would be a backup that looks openable and is not.
ALTER TABLE user_key_backups
    ADD CONSTRAINT user_key_backups_password_copy_complete CHECK (
        (password_wrapped_key IS NULL AND password_kdf_salt IS NULL
             AND password_kdf_memory_kib IS NULL AND password_kdf_iterations IS NULL
             AND password_kdf_parallelism IS NULL)
        OR (password_wrapped_key IS NOT NULL AND password_kdf_salt IS NOT NULL
             AND password_kdf_memory_kib IS NOT NULL AND password_kdf_iterations IS NOT NULL
             AND password_kdf_parallelism IS NOT NULL)
    );

-- The KDF floor moves with the copy it guards. It was written against the
-- password columns, which are on their way out; the recovery copy is the one
-- that has to stay expensive to attack offline, and it is now the only one.
ALTER TABLE user_key_backups
    ADD CONSTRAINT user_key_backups_recovery_kdf_cost CHECK (
        recovery_kdf_memory_kib >= 19456
            AND recovery_kdf_iterations >= 2
            AND recovery_kdf_parallelism BETWEEN 1 AND 4
    );
