# Dedicated backup credentials

> **Status, verified 2026-09-05 against the live host.** This is done. The
> backups upload with `BACKUP_R2_*` to a dedicated `vazute-backups` bucket, and
> the isolation was checked in both directions rather than assumed: the
> application's key gets `403 AccessDenied` listing the backup bucket, and the
> backup key gets `403` listing the application bucket. `REQUIRE_ENCRYPTED_BACKUPS`
> and `REQUIRE_DEDICATED_BACKUP_CREDENTIALS` are both `true`, and every archive
> in the bucket is `.age`.
>
> The section below describes the state this replaced. It is kept because the
> reasoning still explains *why* the separation matters — but it is history, not
> a description of the system. An external audit in September 2026 read it as
> current and raised a High finding on that basis, which is the cost of leaving
> a fixed problem written in the present tense.
>
> **What is still open**, and is the part worth attention: the Age identity that
> decrypts these archives lives on the same VPS the archives protect
> (`BACKUP_AGE_IDENTITY_FILE`), so losing the host loses the ability to read
> them. The off-site copy has also been failing — Google Drive returns
> `storageQuotaExceeded` — which the `cinetrack_backup_offsite_mirrored` alert
> reports. Until both are addressed there is one copy, encrypted with a key that
> dies with the machine.

## Why (historical)

Backups currently upload with `R2_ACCESS_KEY_ID` — the same key the running
application uses for avatars and the poster cache. Anything that compromises the
app therefore also gets write and delete access to every database backup. That
turns a recoverable incident into an unrecoverable one: an attacker who reaches
the app can destroy the evidence and the recovery path in the same step.

`CineTrackBackupUsesSharedCredentials` fires while this is the case. It is
firing now, by design — it is a real finding, not a misconfiguration.

## What to create (Cloudflare dashboard)

This needs the Cloudflare account, so it cannot be scripted from the host.

1. **R2 → Create bucket** → `vazute-backups`.
   A separate bucket rather than a prefix inside `vazute`: R2 API tokens scope
   to a bucket, so a prefix would leave the token able to touch the posters and
   catalogue too.

2. **R2 → Manage API Tokens → Create API Token**
   - Permission: **Object Read & Write**
   - Scope: **specific bucket** → `vazute-backups` only
   - Name it for what it is, e.g. `cinetrack-backup-writer`

3. Put the result in `.env.prod`:

   ```
   BACKUP_R2_S3_API=https://<account-id>.r2.cloudflarestorage.com
   BACKUP_R2_ACCESS_KEY_ID=<from step 2>
   BACKUP_R2_SECRET_ACCESS_KEY=<from step 2>
   BACKUP_R2_BUCKET=vazute-backups
   REQUIRE_DEDICATED_BACKUP_CREDENTIALS=true
   ```

   All four `BACKUP_R2_*` must be set together — the script rejects a partial
   set rather than silently falling back to the shared credentials.

4. Verify, rather than assuming:

   ```bash
   scripts/backup_to_r2.sh              # must not warn about shared credentials
   BACKUP_AGE_IDENTITY_FILE=/home/micu/vazute/backups/cinetrack-backup-age.key \
     scripts/restore_from_r2.sh verify backups/<newest>.dump.age
   ```

   Then confirm the alert clears:

   ```bash
   docker exec cinetrack-monitoring-prometheus-1 \
     wget -qO- 'http://localhost:9090/api/v1/query?query=cinetrack_backup_dedicated_credentials'
   ```

   It should report `1`.

## Migrating the existing backups

The 50 objects already under `backups/` in the shared bucket were written with
the shared key, and older ones are unencrypted. They are not worth moving:
retention is 14 days, so the set turns over on its own. Delete them once a
full encrypted cycle exists in the new bucket — keeping unencrypted dumps of
the whole database around is the exposure this work is closing.

## The encryption key

`BACKUP_AGE_RECIPIENT` is the public half. The private key lives at
`/home/micu/vazute/backups/cinetrack-backup-age.key` (mode 600) and is the only
way to read any backup.

**It is on the same host as the thing it protects.** Copy it somewhere else — a
password manager entry is enough — or a host failure takes the backups with it.
