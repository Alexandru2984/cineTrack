-- Let a lock escalate instead of being pushed forward.
--
-- Every failed attempt against an already-locked account used to move
-- `login_locked_until` to NOW() + 15 minutes. That kept an attacker from
-- collecting a fresh batch of guesses each time a lock expired, which is a real
-- concern — but it also meant anyone who knew the address could hold the owner
-- out indefinitely at one wrong attempt every quarter of an hour, and the owner
-- had to go through email recovery with a password that was never wrong.
--
-- The counter below records how many times this account has been locked in a
-- run, so the next lock can be longer than the last. The attacker gets fewer
-- guesses over time, which is the property worth keeping, and the lock stops
-- being extendable by somebody who never has to know anything.
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS login_lock_level SMALLINT NOT NULL DEFAULT 0;
