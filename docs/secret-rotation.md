# Secret rotation runbook

All runtime secrets live in `.env.prod` (mode 600, gitignored). Editing that
file leaves a `.env.prod.bak*` copy behind; those are cleartext copies of the
**old** secrets, so prune them after rotating:

```bash
scripts/prune-env-backups.sh            # dry run
scripts/prune-env-backups.sh --apply    # keep newest 3, delete the rest
```

Never print a secret to a shared terminal, a commit, or a log. Generate with
`openssl rand` / `head -c … /dev/urandom` and pipe straight into the file.

## Auditing what is on disk

```bash
scripts/check_secret_hygiene.sh             # modes, tracking, ignore rules
scripts/check_secret_hygiene.sh --strict    # also fail on leftover PII exports
```

Run it after every rotation and after any task that drops a credential into the
work tree. It never prints file contents, so its output is safe to paste.

The check exists because gitignoring a secret is not the same as protecting it.
`r2_api_key.txt` was created at mode 0644 and stayed that way: gitleaks reads
history, `git status` reads the index, and neither inspects a file mode, so the
whole pipeline reported green while a live R2 access key was readable by every
process on a host that runs twenty-odd unrelated containers.

**A mode fix is not a rotation.** Tightening permissions stops future reads; it
does nothing about reads that already happened. Any credential found exposed is
compromised until rotated — see the R2 row below.

## Per-secret impact and procedure

| Secret | Blast radius when rotated | How |
|--------|---------------------------|-----|
| `JWT_SECRET` | **Low.** Only signs 15-minute access tokens. Refresh tokens are random and stored SHA-256-hashed, so sessions survive — clients silently re-mint an access token on the next refresh. | `openssl rand -hex 48`, replace value, restart backend. |
| `TOTP_ENCRYPTION_KEY` | **HIGH — do not rotate casually.** AES-GCM key that encrypts stored TOTP secrets (user-bound AAD). Changing it makes every enrolled 2FA secret undecryptable, locking out 2FA users. | Only with a re-encryption migration: decrypt-with-old, re-encrypt-with-new for every row, in one transaction. Otherwise leave fixed. |
| `POSTGRES_PASSWORD` / app + migration role passwords | Medium. Connections drop until env + roles agree. | Rotate the role with `scripts/provision_db_role.sh`, update `APP_DATABASE_URL` / `MIGRATION_DATABASE_URL`, restart. |
| `R2_*` (runtime) and `BACKUP_R2_*` (backups) | Medium. Avatar/poster or backup writes fail until updated. Keep them **separate** keys (see `docs/backup-credentials.md`). | Create a new scoped token in Cloudflare R2, update env, verify with `scripts/backup_to_r2.sh`, then revoke the old token. |
| `SMTP_PASSWORD` | Low. Transactional mail pauses until updated. | Rotate at the mail provider, update env, `cinetrack --check-smtp`. |
| `TMDB_API_KEY` / `TMDB_READ_ACCESS_TOKEN` | Low. Catalogue lookups fail until updated. | Rotate in the TMDB dashboard, update env, restart. |
| `EXPO_PUSH_ACCESS_TOKEN` | Low. Release push notifications pause. | Rotate in Expo, update env, restart. |

## Backup encryption key (age)

`BACKUP_AGE_RECIPIENT` is public; the private key at
`/home/micu/vazute/backups/cinetrack-backup-age.key` (mode 600) is the **only**
way to read any backup and currently lives on the same host it protects. Keep a
copy off-host (a password-manager entry is enough) so a host loss does not take
the backups with it. See `docs/backup-credentials.md`.

## Pending: R2 runtime key

`r2_api_key.txt` in the repository root held a live R2 access key at mode 0644
from 2026-08-12 until it was found and tightened to 0600. Treat that key as
compromised and rotate it:

1. Cloudflare dashboard → R2 → Manage API tokens → create a replacement scoped
   to the `vazute` bucket only.
2. Update `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` in `.env.prod`.
3. `docker compose -f docker-compose.prod.yml up -d --force-recreate backend`
4. Verify an avatar upload and a poster fetch still succeed.
5. Revoke the old token in Cloudflare.
6. Delete `r2_api_key.txt` — the value belongs in `.env.prod`, and a second
   copy is a second thing to leak.
7. `scripts/check_secret_hygiene.sh` to confirm the tree is clean.

## After any rotation

1. `cinetrack --check-config` (and `--check-smtp` if mail changed) to validate.
2. Restart the affected service(s).
3. `scripts/prune-env-backups.sh --apply` to clear the old-secret copy.
4. `scripts/check_secret_hygiene.sh` to confirm nothing was left behind.
