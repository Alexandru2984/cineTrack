# Restore drill, 2026-09-05

An audit noted that `restore_from_r2.sh verify` does not recreate the data and
therefore does not show that a recovery would work. This is the drill that does,
run end to end against the live backups.

## What was run

```
scripts/restore_from_r2.sh verify
scripts/restore_from_r2.sh restore cinetrack_restore_drill_1788619133
```

Both against `backups/cinetrack_20260905_003001.dump.age`, the archive written
by that morning's cron run.

## Result

| step | outcome |
|---|---|
| download and checksum | ok, `sha256=34d387894932…` |
| Age decryption | ok, with the identity on the host |
| archive validation (`pg_restore --list`) | ok |
| restore into a new database | ok, migration metadata verified |
| **wall clock, download to verified restore** | **77 seconds** |

Row counts in the restored database against production at the same moment:

| table | restored | production |
|---|---|---|
| users | 11 | 11 |
| user_media | 3,566 | 3,567 |
| watch_history | 69,994 | 69,995 |
| direct_messages | 2 | 2 |
| media | 7,224 | 7,224 |

The two single-row gaps are writes that happened after the 00:30 dump, which is
what a nightly backup means: the recovery point is the last run, not the moment
of the incident.

The drill database was dropped afterwards.

## What this does and does not establish

**Established.** The archive is intact, the encryption key on the host opens it,
the dump restores into an empty database, and the schema matches what the
migrations expect. Restoring the data is a matter of minutes, not an unknown.

**Not established.** This says nothing about recovering the *host*. The Age
identity lives on the same VPS as the thing it protects, so this drill succeeded
using a key that would be gone in the incident it is meant to survive. That is
the open half of the backup story and no amount of drilling on this machine
closes it.

## RPO and RTO, as measured

- **RPO — worst-case data loss:** up to 24 hours. Backups run at 00:30 daily;
  anything written since the last one is not in the archive. The two-row gap
  above is that window, small only because the drill ran in the morning.
- **RTO — database restore:** 77 seconds measured here, on this host, from a
  warm cache. That is the database only. It excludes rebuilding the host,
  reinstalling Docker, restoring `.env.prod` and its `TOTP_ENCRYPTION_KEY`, and
  bringing the containers up — none of which is measured, and the first of which
  currently has no off-host copy.

Neither number should be quoted as a service commitment until the host rebuild
is drilled too.
