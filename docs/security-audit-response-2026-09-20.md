# Response to the external "Master Technical Audit" — 2026-09-20

An external audit graded Văzute "beta, ready with minor fixes" and listed one
critical and three high findings. Every point was re-checked against the actual
code. The summary up front, because it matters: **the audit describes a system
that is partly not this one** — it names Axum (this backend is actix-web),
`sqlx::query!` macros (this code uses runtime `sqlx::query()` with bound
parameters), a backend port published on `0.0.0.0:8080` (it is
`127.0.0.1:8090`), and a calendar token in a `?token=` query string (it is a
path segment with access logging already off). Several of its findings were
already fixed in this codebase before the audit was written.

What was genuinely actionable: the session regression the owner reported (fixed
here), best-effort key zeroization (done here), and R2 backup immutability (needs
a Cloudflare-account action — steps below). Each finding, with evidence:

## The owner's actual complaint: signed out almost every time — FIXED

Not in the external audit; the real problem. Refresh-token rotation with strict
reuse detection had no grace: the client rotates on every launch, and a lost
rotation response (dropped mobile connection) or two refreshes racing on launch
made the client present the token it had just rotated. That reuse revoked every
session on the account. Fixed in `services/auth.rs`: a 60-second grace window
re-issues on a benign in-grace reuse of a healthy family instead of nuking, while
reuse after the window or on a revoked family still trips the full theft path.
Plus a "keep me signed in" choice at sign-in on both clients (default on),
persistent vs session-scoped. Covered by `test_refresh_reuse_within_grace_*` and
`test_refresh_reuse_after_grace_is_theft`.

## [SEC-CRIT-01] R2 backup immutability — CONFIRMED OPEN (needs Cloudflare account)

Re-tested against the live bucket on 2026-09-22 rather than reasoned about, and
the finding holds — with one correction in the project's favour and one against.

In its favour: backups do **not** use the application's credentials. All four
`BACKUP_R2_*` variables are set, so `scripts/backup_to_r2.sh` writes to a
dedicated bucket (`vazute-backups`) with a dedicated key, and the script requires
that separation by default (`REQUIRE_DEDICATED_BACKUP_CREDENTIALS`). The audit
described the shared-credential case, which is the fallback, not the configuration.

Against it: the dedicated key **can delete**. Probed with a `DeleteObject` against
a key that does not exist — which touches no backup and changes nothing — and it
returned success rather than `AccessDenied`. So a host compromise still reaches
every snapshot. `GetObjectLockConfiguration` and `GetBucketVersioning` both return
`AccessDenied` for this key, so the server cannot read, let alone set, the bucket's
lock state.

That is why this stays open and cannot be closed from the machine: the fix needs
account-level authority the host deliberately does not have.

1. Enable Object Lock / a default retention (e.g. 30 days) on `vazute-backups`.
2. Mint a backup-only R2 token with `PutObject` and no `DeleteObject`, and put it
   in the `BACKUP_R2_*` variables.
3. Re-probe afterwards: the same `DeleteObject` against a nonexistent key should
   then answer `AccessDenied`.

Lifecycle *expiry* is configured (`scripts/configure_r2_lifecycle.sh`), but expiry
is not immutability and does not address this.

## [SEC-HIGH-01] SSE holds a PostgreSQL connection — NOT TRUE (already correct)

`routes/events.rs` and `services/events.rs` hold no pool connection: the stream
authenticates the JWT in memory and subscribes to a `tokio::sync::broadcast`
receiver. There is no `PgPool`/`acquire`/`begin` anywhere in either file. The
exact design the audit recommends is what is already there.

## [SEC-HIGH-02] Mobile E2EE derivation freezes the UI (ANR) — PREMISE WRONG

Message decryption uses x25519 + HKDF-SHA256 + AES-GCM (`lib/crypto/core.ts`),
which are sub-millisecond; decrypting an inbox does not block. The only heavy KDF
is Argon2id, used solely to unwrap the identity from the recovery code — a rare,
one-per-device unlock, not a per-message or per-screen cost. There is no "5–8s
freeze on opening messages". A native-crypto rewrite would add a heavy dependency
for no measured benefit and is not warranted.

## [SEC-HIGH-03] Backend port on 0.0.0.0 — NOT TRUE (already correct)

`docker-compose.prod.yml` binds `127.0.0.1:8090:8080` (backend) and
`127.0.0.1:8091:8080` (frontend). Nothing is published on a public interface.

## [SEC-MED-01] No singleflight on TMDB fetches — NOT TRUE (already correct)

`services/tmdb.rs` coalesces concurrent identical fetches: `get_or_cache_media`
takes a per-key `acquire_request_lock("detail:{type}:{id}")` and re-checks the
cache under it (double-checked locking), so a burst for one uncached title makes
one TMDB call and the rest read the cache.

## [SEC-MED-02] Calendar feed token logged / no revoke — ALREADY DONE

Token is a path segment, not a query string; nginx has `access_log off` on
`^~ /api/calendar/feed/`. The web settings already expose regenerate/disable
(`components/CalendarFeedCard.tsx`).

## [SEC-MED-03] No first-line rate limiting at the proxy — ALREADY DONE

nginx applies `limit_req zone=vazute_auth` (30/min) to `/api/auth/`, in front of
the backend's own limiter.

## [SEC-LOW-01] Private keys not zeroized on the web — FIXED

`wipeIdentity()` (shared `crypto/core.ts`) now overwrites the private-key bytes on
sign-out, on both clients. Best-effort, as the audit notes JS allows.

## [SEC-INFO-01] Local patch for decode-uri-component — informational

Left as is; revisited on the next Expo SDK bump.

## Also confirmed already-correct

Mass assignment (`#[serde(deny_unknown_fields)]` on every request DTO); IDOR/BOLA,
JWT algorithm pinning, message franking, path traversal, SSRF and SQL injection —
all verified clean in the static and dynamic passes recorded in
`security-audit-2026-09-15.md`.

## Verdict

The one substantive open item is R2 Object Lock, which is a Cloudflare-account
action. The session regression is fixed. The rest of the external audit's
critical/high list was already handled or rested on a wrong reading of the stack.
