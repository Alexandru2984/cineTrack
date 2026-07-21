# Incident response — Văzute

One page, because a runbook nobody reads during an incident is not a runbook.
Commands here are copy-pasteable and have been run at least once, so they are
not being tried for the first time under pressure.

**Operator:** Dragne Alexandru Mihai · **Alerts:** 984.alexmihai@gmail.com

## 0. First five minutes

Before fixing anything, write down the time you became aware. GDPR's 72-hour
clock starts there, and reconstructing it afterwards is guesswork.

```bash
date -u +%FT%TZ                                   # note this
docker compose -f docker-compose.prod.yml ps      # what is actually up
docker logs --tail 200 cinetrack-backend-1
```

## 1. Suspected account takeover (single user)

```bash
# Revoke every session for one account. They must sign in again; a stolen
# refresh token stops working immediately.
docker exec cinetrack-db-1 psql -U cinetrack_user -d cinetrack -c \
  "DELETE FROM refresh_tokens WHERE user_id = '<uuid>';"
```

Then check what the account did:

```bash
docker exec cinetrack-db-1 psql -U cinetrack_user -d cinetrack -c \
  "SELECT created_at, user_agent, ip_address FROM refresh_tokens
   WHERE user_id = '<uuid>' ORDER BY created_at DESC LIMIT 20;"
```

The app already defends the obvious paths: five failed sign-ins lock the
account for 15 minutes, and reusing a rotated refresh token revokes that whole
token family automatically. If you are here, assume the password itself leaked
and tell the user to change it.

## 2. Suspected server compromise

Assume every secret on the host is exposed.

```bash
# 1. Cut off all sessions everywhere.
docker exec cinetrack-db-1 psql -U cinetrack_user -d cinetrack -c \
  "DELETE FROM refresh_tokens;"

# 2. Rotate JWT_SECRET in .env.prod, then restart. This invalidates every
#    access token that is still in flight.
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d backend
```

Then rotate, in this order: `JWT_SECRET`, R2 keys, Resend SMTP password, TMDB
key. **Do not rotate `TOTP_ENCRYPTION_KEY`** — it decrypts stored 2FA secrets,
and changing it locks out every enrolled user.

> **Rotating the SMTP password also breaks alerting until you re-render the
> Alertmanager config.** It uses the same Resend credentials, rendered once into
> a file. After changing `SMTP_PASSWORD` in `.env.prod`, run
> `scripts/render_alertmanager_config.sh` and restart the alertmanager
> container, or alerts will silently stop being delivered — during the exact
> incident you most need them.

## 3. Restore from backup

Backups are age-encrypted, run daily at 03:30, and keep 14 days.

```bash
KEY=/home/micu/vazute/backups/cinetrack-backup-age.key

# Always verify before restoring — this decrypts and validates the archive
# without touching the database.
BACKUP_AGE_IDENTITY_FILE=$KEY \
  scripts/restore_from_r2.sh verify backups/<file>.dump.age

# Restore into a scratch database first. The script refuses to overwrite
# production without an explicit confirmation, deliberately.
BACKUP_AGE_IDENTITY_FILE=$KEY \
  scripts/restore_from_r2.sh restore cinetrack_scratch backups/<file>.dump.age
```

Without that private key no backup can be read. If it is not also stored off
this host, fix that before you need it.

## 4. GDPR notification — 72 hours

Applies when personal data was likely exposed: email addresses, or watch
history (behavioural data, and it is personal data here).

The window starts at **awareness**, not at breach. Write down what you know:
what happened, when, whose data, what you have done. If you cannot answer those
in 72 hours, notify anyway with what you have — a partial notification on time
beats a complete one late.

Romanian supervisory authority: ANSPDCP (dataprotection.ro).

### Draft to users

> Subject: Security incident affecting your Văzute account
>
> On <date> we discovered <what happened>. Your <email address / watch history>
> may have been accessed. Passwords are stored hashed with Argon2id and were not
> exposed in a usable form.
>
> We have <what you did>. As a precaution, please change your password and
> enable two-factor authentication in Settings.
>
> If you have questions, reply to this message.

Plain and specific. No "we take security seriously."

## 5. After

- Note the timeline in `SECURITY_AUDIT.md` while it is fresh.
- If detection was slow, add the alert that would have caught it — that is what
  `ops/prometheus/cinetrack-alerts.yml` is for.
- Re-run this page's commands afterwards to confirm they still work. Anything
  here that was wrong when you needed it should be fixed the same day.
