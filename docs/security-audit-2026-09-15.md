# Security audit — 2026-09-15

Whole codebase, not a diff: the Rust backend (~33k lines across 92 source files,
23 route modules, 68 migrations), the React web client (~26k lines), the Expo
mobile client (~30k lines), the operational scripts, the edge configuration and
the running production containers.

This is the fourth full-codebase pass on the record (see the July and August
reviews in this directory). Those closed real holes — message authentication,
message-thread IDOR, private-IP proxy trust, avatar-key guessability, unsigned
franking evidence. This round re-attacked the same surface as a hostile client
and looked for what a checklist misses: chained flows, timing oracles, resource
abuse, and the moments a trusted component (GitHub, Cloudflare, a peer, a
neighbouring container) could lie.

Every statement below was checked against the code or against the live origin,
and is cited. Where a comment made a security claim, the claim was tested against
the implementation rather than trusted.

## Method

- Enumerated the route tables and, for each handler on a sensitive surface, read
  the body and confirmed what gate it runs before it touches data.
- Read the authentication core end to end: JWT minting/validation, the
  revocation cache, refresh-token rotation, and every login/register/reset flow.
- Traced the client-IP chain from the Cloudflare edge through nginx `real_ip`
  into the backend rate limiter, because every per-IP control depends on it.
- Grepped the whole backend for dynamic SQL, `unsafe`, timing-unsafe secret
  comparison, and outbound HTTP (the SSRF surface), then read every hit.
- Probed the live origin for security headers and the Cloudflare-only lock.
- Checked that no secret is tracked in git and that the compose file pins the
  hardening the code relies on.

## Verified clean

Listed because "we looked" is part of the result.

**Authentication (`utils/jwt.rs`, `middleware/auth.rs`).** `Validation::new(HS256)`
pins the algorithm, so `alg:none` and an RS256/HS256 confusion are refused by the
library, not by us. `exp` is required and checked with 5s leeway; `sid` is a
non-optional `Uuid`, so a token that strips it fails to deserialise rather than
becoming un-revocable. Every authenticated entry point runs the in-process
revocation check (`reject_revoked`), so "sign out everywhere" takes effect at
once. The gate fails closed with no `Data<Config>`. Rejections are uniform, so a
revoked credential learns only that it no longer works.

**Sessions & recovery (`services/auth.rs`).** Refresh tokens are 64 random bytes,
stored only as SHA-256. Login equalises timing (`verify_password_or_dummy` for a
nonexistent account, a response-time floor for a locked one), refuses a locked
account *before* the hash so there is no 401-vs-429 oracle, and only reveals 2FA
after the password is right. Register uses `ON CONFLICT DO NOTHING` with a
generic error and hashes unconditionally, so it discloses neither existence nor
timing. `forgot_password` returns the same answer and same latency whether or not
the address exists, throttles re-issues, and delivers the token in the URL
*fragment* so it never reaches the server logs. `reset_password` tokens are
one-time (`consumed_at` under `FOR UPDATE`), expire in an hour, and clear the
login lock so a victim an attacker locked out can still recover.

**Authorization / IDOR.** Direct messages are filtered on the ordered pair in
both directions (`messages.rs:292,320`), so a thread cannot be read across
accounts; `mark_thread_read` verifies the message's ownership before it writes.
Moderation requires a `moderators` row *plus* verified email *plus* enabled 2FA,
re-checked inside the write transaction with the report locked `FOR UPDATE`, with
state-machine transitions and an append-only audit log (`moderation.rs`). Writes
in `lists.rs`, `history.rs` and `notifications.rs` are scoped by `user_id`.
Self-follow and self-block are refused (`users.rs:983,1194`).

**End-to-end-encrypted message franking (`services/franking.rs`).** Commitment is
HMAC-SHA256 compared in constant time; the signature is Ed25519 over
`commitment || client_nonce` (so a signature cannot be lifted onto another
message), verified at send against the recorded key (so a report survives key
rotation); wrong lengths are rejected before any comparison and the reporter-
facing error is uniform across failure kinds.

**Path traversal (`routes/assets.rs`).** Avatar keys parse every segment as a
UUID; poster specs are allow-listed by TMDB size and a strict character set, with
tests for percent-encoded, backslash, null-byte and double-extension traversals.

**SSRF (`services/tmdb.rs`, `push.rs`, `password_breach.rs`).** Every outbound
request goes to a fixed host from config with `redirect::Policy::none()`; the only
user-influenced path component (the poster spec) is validated first. No
user-controlled host, no redirect following.

**SQL injection.** No dynamic SQL: 274 parameterised `query`/`query_scalar` calls
bind their inputs, and the two `QueryBuilder` sites use `push_bind` for every
value and `push` only for static fragments.

**Client-IP integrity (`middleware/rate_limit.rs` + edge).** `cloudflare-realip.conf`
rewrites `$remote_addr` from `CF-Connecting-IP` only for peers inside the
published Cloudflare ranges (plus loopback for the tunnel); the origin guard keys
on `$realip_remote_addr` — the true peer, not the rewritten one. The backend
trusts `X-Forwarded-For` only from `TRUSTED_PROXY_IPS`, pinned in
`docker-compose.prod.yml` to the bridge gateway, which closes the
neighbouring-container spoof the code comments describe. Per-IP limits are
therefore per real client.

**Unauthenticated sinks (`csp_report.rs`, `client_errors.rs`).** Both cap the body,
are IP-rate-limited, log through `serde_json` (no log injection), strip query and
fragment from URIs (so a leaked token is not re-logged), and normalise to
fixed-cardinality metrics. Client-error reports also reject stale or future
timestamps.

**Resource abuse (`import.rs`, `events.rs`).** Import caps each file at 16 MB and
the upload at 24 MB while streaming, caps rows, admits two imports at a time via a
semaphore, parses with a real CSV reader, and does not decompress — no zip bomb.
The SSE stream caps connections per user, re-checks revocation on every keepalive,
and frees the channel on every exit path via a `Drop` guard.

**Web/mobile injection.** No `dangerouslySetInnerHTML`, `innerHTML`, `eval` or
`document.write` in the web client. External watch-provider links are sanitised
(`safeWatchProviderLink`: https only, trusted host, no credentials, fragment
stripped) on both clients, and external anchors carry `rel="noopener noreferrer"`.

**Secrets & supply chain.** No `.env`, key, credential or PEM file is tracked in
git; `.gitignore` plus `scripts/check_secret_hygiene.sh` enforce it. `cargo audit`
is clean but for the documented yanked `chacha20`; rustls is 0.23.45
(RUSTSEC-2026-0285 closed this session); the npm audits carry two reviewed
`image-size` exceptions.

**Live posture (through Cloudflare, 2026-09-15).** HSTS (1y, includeSubDomains),
a strict CSP with no `script-src 'unsafe-inline'`, `X-Frame-Options: DENY`,
`nosniff`, COOP/CORP `same-origin`, and a locked-down `Permissions-Policy` are all
served. The backend and web containers bind only to loopback; the backend image
is distroless (no shell).

## Findings

None this round required a code change. The classes that produced findings in
July and August — message authorization, proxy trust, franking evidence, key
guessability — are the ones re-checked most closely here, and each remained
closed.

## Not verified here

- No authenticated dynamic fuzzing or live scanning was run against production;
  the live checks were passive (headers, the Cloudflare-only lock) plus local
  reasoning against a copy.
- The backend was not read line-by-line in full; the highest-risk handlers and
  the shared query/authorisation patterns were, and the patterns are consistent.
- Cryptographic primitives (`aws-lc-rs` Ed25519, Argon2, X25519/HKDF/AES-GCM) are
  taken as sound *as used*; their usage was reviewed, not their implementations.
- The ~70 unrelated apps co-hosted on this VPS are out of scope. One aside for
  the owner, not a Văzute finding: several of their admin UIs (portainer, uptime,
  analytics, hooks) proxy without an nginx-level auth gate and rely on their own
  logins or on Cloudflare Access — worth confirming that reliance is real.

## Verdict

Văzute is in strong shape. The application core — auth, session recovery,
message authorization, E2EE franking — is hardened well beyond what its size
would predict, and the operational layer (origin lock, real-IP chain, container
isolation, secret hygiene) matches it. An external reviewer will find a mature,
defensible system, not low-hanging fruit.
