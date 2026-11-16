# Security audit report — Văzute

Date: 2026-11-15. Commit audited: `fac206b` (main, clean tree).
Scope: authorized defensive review of the local repository. No request was sent
to the public site, no production container, database or configuration was
touched, and no application code was changed.

> **Status, 2026-11-16: every finding below is resolved.** This file was kept
> out of the public repository until then and is committed together with the
> last fixes, as earlier audits were. The report is left as written on
> 2026-11-15; what changed for each finding, and the test that holds it, is in
> section 0.

## 0. Resolution

Each code fix has a regression test that fails without it and passes with it,
except where noted. Line references in the findings point at the audited
commit, not at today's code.

| ID | Status | What changed | Held by |
|---|---|---|---|
| VAZ-01 | Fixed (#384) | Issuing a session re-reads the password hash `FOR SHARE` and refuses if it changed since the password was checked. | `test_a_password_change_ends_a_sign_in_that_was_in_flight`, `test_a_password_reset_ends_a_sign_in_that_was_in_flight` |
| VAZ-02 | Fixed (#385) | The block list returns a private account's avatar only when it is public. | `test_the_block_list_hides_a_private_accounts_avatar` |
| VAZ-03 | Fixed | "Sign out everywhere" runs the same cancellation as a password change: calendar feed off, push devices removed, pending email change and reset links cancelled. Feed changes are recorded in the security timeline. | `signing_out_everywhere_cuts_the_feed_and_push_devices`, `disabling_the_calendar_feed_is_recorded_once` |
| VAZ-04 | Fixed | Siblings orphaned by the grace window are kept as consumed rather than deleted, so presenting one later is reuse. | `test_a_sibling_orphaned_by_the_grace_window_is_reuse_when_presented`, `test_a_client_that_kept_one_grace_successor_keeps_its_session` |
| VAZ-05 | Fixed for email change; registration accepted | A taken address is answered exactly like a free one, after the cooldown, and no link is sent. Registration stays binary in outcome: closing it needs an email-first sign-up, which is a product change, and the auth rate limits bound it. | `test_an_email_change_answers_alike_whether_the_address_is_taken` |
| VAZ-06 | Fixed | Image proxy: only the sizes the apps use, a daily miss budget (1,000 per address, 20,000 in all), names TMDB lacks remembered for an hour, and an alert when the budget is spent. | `the_miss_budget_*` and `a_name_tmdb_does_not_have_*` unit tests, `CineTrackPosterFetchBudgetSpent` promtool test |
| VAZ-07 | Fixed (#385) | An anonymous caller gets no id or join date for a private account. | `test_an_anonymous_caller_learns_no_id_or_join_date_of_a_private_account` |
| VAZ-08 | Fixed | Staff, service and route names are reserved in any case and with or without `_` and `-`; no existing account held one. | `test_staff_like_usernames_cannot_be_registered_or_taken_later`, `refuses_staff_and_service_names_in_any_case_or_spelling` |
| VAZ-09 | Fixed | Signatures cover a version label and both account ids. Ids rather than key fingerprints, because keys rotate. Clients check against the thread's accounts, not the row's. The old layout is refused, not kept as a fallback; production held no encrypted message. Server and both clients share one test vector. | `a_signature_made_for_one_recipient_fails_for_another`, `a_signature_made_for_another_recipient_is_refused_at_send`, `a_report_on_a_message_signed_for_somebody_else_is_refused`, client "withholds a copy sealed to this reader under a signature for somebody else". The new tests cannot compile against the old signature functions. |
| VAZ-10 | Fixed | Recovery codes carry 80 bits (16 base32 characters). Existing hex codes keep working, input is normalised, and the app accepts both formats. | `test_recovery_codes_are_80_bits_and_old_ones_still_work`, `a_recovery_code_matches_however_it_is_typed` |
| VAZ-11 | Fixed on the host | `scripts/prune-env-backups.sh --apply` removed the stale copies; the secret hygiene check reports no warnings. | `scripts/check_secret_hygiene.sh` |
| VAZ-12 | Fixed | The mobile gate fails at moderate. The one remaining moderate advisory (minimatch, build and lint tooling only) is accepted by name and pinned to the exact versions reviewed. | `scripts/tests/audit_exceptions_gate_test.py`, `npm run audit:high` |
| VAZ-13 | Fixed | A web sign-in without "Keep me signed in" now loses its message keys on sign-out, and on the next visit when no session survived. The login form says so. Keys stay unwrapped in IndexedDB while signed in; that trade-off and the CSP mitigation are unchanged. | `crypto-retention` and `session-lifecycle` tests |
| VAZ-14 | Fixed | Each address may hold at most two places in the Argon2 pool, and the rest of a burst is refused before hashing. The edge allows sign-in and registration 6 times a minute per address instead of 30, so saturating the pool takes several hundred addresses rather than about seventy. | `test_one_address_cannot_queue_more_than_its_share_of_sign_ins`, `one_address_cannot_hold_more_than_its_share_of_the_pool`, `edge_security_config_test.sh` |
| VAZ-15 | Fixed | One CSP report writes at most ten lines plus a summary; the metric still counts every entry. | `a_report_packed_with_entries_writes_a_bounded_number_of_lines` |
| VAZ-16 | Fixed | `nginx/README.md` now describes the Cloudflare Tunnel in use (catch-all to host nginx on loopback, ports 80 and 443 closed by ufw) and why the real-IP and origin-guard files trust loopback. | Documentation |

## 1. Executive summary

Văzute has been audited several times and it shows: bound SQL parameters
everywhere, hashed single-use tokens, Argon2id, access-token revocation, strict
CSP, non-root read-only containers, a restricted database role, pinned images
and actions. No critical or high-severity issue was found.

Sixteen findings remain: **2 medium, 6 low, 8 informational**. Eight were
reproduced against a throwaway local instance with synthetic accounts.

The two that matter most:

- **A sign-in in flight survives a password change or reset.** Someone who knows
  the old password and is signing in at that moment keeps a working session.
  Measured on a release build: 3 of 30 password changes from one address, 12
  of 30 from five. The same race was closed for token rotation in September;
  sign-in was missed.
- **Blocking a private account returns its avatar URL.** Every other endpoint
  hides it from viewers the account has not approved.

Not having found more is not proof there is no more. Section 11 lists what
could not be checked from here, and what each item would need.

## 2. Architecture as found

| Component | What the code shows |
|---|---|
| Backend | Rust, actix-web 4, sqlx with runtime-bound queries, one process. 26 route modules, 74 migrations. |
| Web | React + TypeScript (Vite), PWA service worker, static nginx container. |
| Mobile | React Native / Expo SDK 57, Android App Links, SecureStore. |
| Data | PostgreSQL 16 on an internal Docker network; runtime role without DDL rights. |
| Objects | Cloudflare R2: avatars and a TMDB poster cache; a separate bucket and key for backups. |
| Edge | Cloudflare → host nginx (443) → loopback ports 8090 (API) and 8091 (web). `nginx/README.md` says there is no Cloudflare Tunnel; a `cloudflared` service is running on the host (VAZ-16). |
| Integrations | TMDB (fixed hosts, no redirects), SMTP via lettre, Expo push, HIBP k-anonymity. |

Trust boundaries: the edge sets the client address (`X-Forwarded-For`
overwritten, backend trusts one proxy IP); the bearer access token (HS256, 15
minutes, carries a session id) is the API credential; the refresh token is an
`HttpOnly; SameSite=Strict; Path=/api/auth` cookie on web and a SecureStore
entry on mobile; direct messages are end-to-end encrypted with keys the server
never holds.

## 3. Findings

| ID | Title | Severity | Confidence |
|---|---|---|---|
| VAZ-01 | A sign-in in flight survives a password change or reset | Medium | Confirmed |
| VAZ-02 | Blocking a private account reveals its avatar | Medium | Confirmed |
| VAZ-03 | "Sign out everywhere" leaves the calendar feed and push registrations | Low | Confirmed |
| VAZ-04 | Refresh grace window lets a replayed token avoid reuse detection | Low | Confirmed |
| VAZ-05 | Email change and registration reveal whether an address is registered | Low | Confirmed |
| VAZ-06 | Anyone can make the server fetch and store arbitrary TMDB images | Low | Likely |
| VAZ-07 | Profile endpoint confirms private accounts to anonymous callers | Low | Confirmed |
| VAZ-08 | Staff-like usernames can be registered | Low | Confirmed |
| VAZ-09 | Message signature does not name sender or recipient | Informational | Confirmed |
| VAZ-10 | Two-factor recovery codes are 64-bit, unsalted SHA-256 | Informational | Confirmed |
| VAZ-11 | Five stale copies of production secrets in the working tree | Informational | Confirmed |
| VAZ-12 | Moderate advisories in mobile build tooling are not gated | Informational | Confirmed |
| VAZ-13 | Web keeps message private keys unwrapped, and across sign-out | Informational | Confirmed |
| VAZ-14 | Password-hashing pool is a shared unauthenticated bottleneck | Informational | Potential |
| VAZ-15 | One CSP report can write hundreds of log lines | Informational | Confirmed |
| VAZ-16 | The edge topology document contradicts the running host | Informational | Confirmed |

## 4. Medium

### VAZ-01 — A sign-in in flight survives a password change or reset

- **Severity:** Medium. **Confidence:** Confirmed (reproduced locally).
- **Component:** backend, authentication service.
- **Where:** `backend/src/services/auth.rs:182-185` (user row read once, no
  lock), `:219` (password verified against that copy), `:283-291` and
  `:1631-1679` (`issue_token_pair` inserts the session without reading `users`
  again). Compare `:346-357`, where rotation takes the row `FOR SHARE`, and the
  revoking paths at `:590-610` (change) and `:752-775` (reset).
- **Explanation:** a password change or reset revokes with
  `UPDATE refresh_tokens … WHERE user_id = $1` and an access-token cutoff of
  "now". A sign-in that read the old hash before that commit and inserts its
  refresh token after it is not in the statement's snapshot, and its access
  token is minted after the cutoff. Finding 4 of the 2026-09-23 audit closed
  this for rotation; sign-in never takes the same lock.
- **Impact:** someone who knows the current password keeps a session through
  the change meant to evict them, for up to 30 days of refreshes. The window is
  one password verification, 0.15 s on a release build. The attacker cannot see
  when the owner acts, so they must keep signing in, which is noisy: sign-in
  emails, and the owner's oldest sessions are evicted past five. Accounts with
  two-factor are far harder, because a TOTP step is accepted once.
- **Evidence.** Release build, one sign-in 0.152 s (median of 5). The attacker
  signs in with the old password once every two seconds per address, which is
  the edge's limit of 30 a minute; the owner changes the password at a random
  moment; 30 trials each:

  | Attacker addresses | Password changes the attacker's session survived |
  |---|---|
  | 1 | 3 of 30 |
  | 5 | 12 of 30 |

  The sequence itself, on a debug build where Argon2 takes 2.5 s:

  ```
  password change: 200
    sign-in #1: began -2.69s, ended -0.30s vs change -> /auth/me 401, refresh 401
    sign-in #2: began -1.68s, ended +0.74s vs change -> /auth/me 200, refresh 200  SURVIVED
    sign-in #3: began -0.68s, ended +1.68s vs change -> /auth/me 200, refresh 200  SURVIVED
    sign-in #4: began +0.33s                         -> HTTP 401
  password reset: 200 — 2 sessions opened with the old password survived as well
  ```
- **Remediation:** in the transaction that inserts the session on the sign-in
  path, take `SELECT password_hash FROM users WHERE id = $1 FOR SHARE` and
  refuse with the generic 401 if it differs from the hash that was verified.
  Change and reset update the account row first, so the two serialize exactly
  as rotation already does.
- **Regression test:** an integration test in the style of
  `test_a_password_change_ends_a_session_that_is_refreshing_in_a_loop`: 20
  trials of concurrent old-password sign-ins and a password change, then assert
  that every token those sign-ins returned is refused. Repeat for reset.

### VAZ-02 — Blocking a private account reveals its avatar

- **Severity:** Medium. **Confidence:** Confirmed (reproduced locally).
- **Component:** backend, social routes.
- **Where:** `backend/src/routes/users.rs:1157-1181` (query at `:1163-1169`
  selects `blocked.avatar_url` unconditionally),
  `backend/src/dto/report.rs:100-106`. The rule it skips is applied at
  `users.rs:160-171` (search), `:275-291` (profile), `:1128-1130` (follow
  requests) and `:1394-1397` (followers). The web shows the value at
  `frontend/src/components/BlockedUsersCard.tsx:54-56`.
- **Explanation:** avatar keys carry a per-upload nonce
  (`routes/assets.rs:427-442`) so a private account's picture cannot be fetched
  without being handed the URL. `GET /api/users/me/blocks` hands it over.
- **Impact:** any signed-in account, with no verified email, can obtain the
  picture of any private account whose username it knows; user search lists
  private accounts by prefix. Blocking is invisible to the target, can be
  undone immediately, and the limit is 5,000 blocks.
- **Evidence:**

  ```
  victim is_public: f
  profile  avatar_url: None      search avatar_url: None
  block status: 201
  blocks   avatar_url: <the private URL>
  ```
- **Remediation:** `CASE WHEN blocked.is_public THEN blocked.avatar_url END` in
  that query. A blocker is never an accepted follower, because blocking deletes
  the follow. Better: one shared SQL fragment for "may this viewer see private
  details", used by every query that returns `avatar_url` or `bio`.
- **Regression test:** private account with an avatar, second account blocks
  it; assert `avatar_url` is null in `/users/me/blocks`, and present for a
  public account.

## 5. Low

### VAZ-03 — "Sign out everywhere" leaves the calendar feed and push registrations

- **Confidence:** Confirmed. **Component:** backend auth, calendar, push.
- **Where:** `backend/src/services/auth.rs:1922-1955` (`logout_all_sessions`)
  does not call `cancel_pending_credential_actions` (`:1777-1832`), which is
  what clears both. `backend/src/routes/calendar.rs:700-715` mints the feed URL
  with a session alone and records nothing in
  `services/security_activity.rs:12-32`.
- **Impact:** a briefly stolen access token can mint a feed URL or register a
  device; both keep delivering the owner's tracked titles and air dates after
  the owner signs out everywhere, with no entry in the security timeline.
- **Evidence:** `feed after logout-all: 200 | push devices left: 1`; control:
  `feed after password change: 404 | push devices left: 0`.
- **Remediation:** clear `calendar_feed_token_hash` and `push_devices` in
  `logout_all_sessions`; record feed enable/disable as security activity.
- **Regression test:** enable feed, register device, call logout-all, assert the
  feed URL answers 404 and no device row remains.

### VAZ-04 — Refresh grace window lets a replayed token avoid reuse detection

- **Confidence:** Confirmed. **Component:** backend auth.
- **Where:** `backend/src/services/auth.rs:54`, `:384-422` (reuse within 60 s is
  re-issued), `:457-475` (a later rotation deletes live siblings).
- **Explanation:** if a thief and the owner both present the same refresh token
  within 60 seconds, both get a live successor. Whoever rotates next, more than
  60 seconds later, deletes the other's row. A deleted row answers "Invalid
  refresh token", not the theft path.
- **Impact:** a thief holding a stolen token pair knows from `exp` when the
  client will refresh, replays just before it, rotates a minute later, and
  keeps the session. The owner is signed out as if the session had expired; no
  alarm, no revocation.
- **Evidence:** `thief rotates again: 200`, `owner refreshes: 401 Invalid
  refresh token`, `thief can keep refreshing: 200`, account-wide revocations
  recorded: 0, reuse alarms in the log: 0.
- **Remediation:** mark orphaned siblings consumed instead of deleting them, so
  presenting one later trips reuse detection; or re-issue inside the window
  only to the client address and agent that performed the first rotation.
- **Regression test:** the sequence above, asserting the owner's later refresh
  revokes every session of the account.

### VAZ-05 — Email change and registration reveal whether an address is registered

- **Confidence:** Confirmed. **Component:** backend auth.
- **Where:** `backend/src/services/auth.rs:930-944` (the "already in use" check
  runs before the cooldown at `:950-976`); `:101-124` (registration is generic
  in wording but binary in outcome).
- **Impact:** a signed-in account can test addresses at the auth rate limit;
  sign-in and password reset go out of their way to hide the same fact.
- **Evidence:** registered address `409 That email address is already in use`
  (also during the cooldown); unused `200`, then `429`.
- **Remediation:** answer every email-change request identically and move the
  cooldown ahead of the lookup. Registration can only be closed by an
  email-first flow; otherwise record it as accepted.
- **Regression test:** the response for a taken address equals the response for
  a free one, status and body.

### VAZ-06 — Anyone can make the server fetch and store arbitrary TMDB images

- **Confidence:** Likely (code reading; needs R2 to measure).
- **Where:** `backend/src/routes/assets.rs:33-35`, `:63-75`, `:79-96`,
  `:598-639`; `backend/src/services/tmdb.rs:20-21`, `:682-699`;
  `nginx/vazute.micutu.com.conf:99-104`; `scripts/configure_r2_lifecycle.sh`
  (175-day retention).
- **Explanation:** `/api/img/{size}/{file}` is public. Every new well-formed
  name costs an R2 read, a TMDB download of up to 15 MB and an R2 write kept
  for 175 days. A name that does not exist is not remembered, so it costs the
  read and the download attempt every time.
- **Impact:** storage and operation charges, and outbound traffic, driven by
  unauthenticated requests. Bounded by 8 concurrent fetches and 30 requests per
  second per address, not by volume.
- **Remediation:** a per-address and a global daily budget for cache misses,
  short negative caching, an alert on bucket size, and drop sizes no client
  requests.
- **Regression test:** unit test that the miss budget refuses the request after
  the limit while cached images still serve.

### VAZ-07 — Profile endpoint confirms private accounts to anonymous callers

- **Confidence:** Confirmed. **Where:** `backend/src/routes/users.rs:217-303`
  (`:223` makes auth optional, `:279-302` returns `id` and `created_at`).
  `routes/unfurl.rs:275-293` deliberately returns a generic card for the same
  account.
- **Impact:** without signing in, anyone can confirm a username exists and read
  its account id, creation time and privacy flag.
- **Evidence:** anonymous `GET /api/users/<private>`: 200 with `id` and
  `created_at`; the preview card for the same name is the generic one.
- **Remediation:** for viewers who may not see private details, omit `id` and
  `created_at`, or require a session.
- **Regression test:** anonymous request for a private profile carries neither
  field.

### VAZ-08 — Staff-like usernames can be registered

- **Confidence:** Confirmed. **Where:** `backend/src/dto/validation.rs:3-23`,
  `backend/src/dto/auth.rs:20-24`,
  `backend/migrations/20240111000000_constrain_usernames.sql:7-9`.
- **Impact:** `admin`, `support`, `moderator` and `vazute` all registered
  locally (201). A follow request or message from such a name is a ready
  pretext. Names such as `search` also collide with fixed routes.
- **Remediation:** a case-insensitive reserved list on registration and profile
  update, and a check for existing accounts.
- **Regression test:** unit test of the validator with the reserved names.

## 6. Informational

- **VAZ-09 — Message signature does not name sender or recipient.**
  `frontend/src/lib/crypto/core.ts:316-321`, `:357-415`;
  `backend/src/services/franking.rs:130-135`. The Ed25519 signature covers the
  commitment and the client nonce only. Under the documented threat (a passive
  copy of the database) nothing follows. Someone who can write rows and knows a
  message's plaintext could re-address a signed envelope to another recipient,
  where it verifies as authentic. Fix: sign both parties' key fingerprints and
  a version label. Test: a signature made for one recipient fails for another.
- **VAZ-10 — Recovery codes are 64-bit, unsalted SHA-256.**
  `backend/src/services/auth.rs:1291`, `:1512-1517`, `:1601-1617`. Online
  guessing is stopped by the lock. After a database leak all codes can be
  attacked at once; a code is only useful with the password. Fix: 80+ bits, or
  HMAC with a server key. Test: generated code length and stored-hash format.
- **VAZ-11 — Five stale `.env.prod.bak*` files** in the repository root (mode
  600, ignored by git). `scripts/check_secret_hygiene.sh` warns: wants at most
  three. Run `scripts/prune-env-backups.sh --apply`.
- **VAZ-12 — Mobile gate blocks only high and critical.**
  `mobile/package.json:66`, `mobile/scripts/check_audit_exceptions.py:26`.
  `npm audit` reports 9 moderate, all through `minimatch`
  (GHSA-g3hv-75wg-m249) in build and lint tooling, and 10 low through
  `deepmerge` (GHSA-gcqx-w48m-w2h4); the web has 4 low through the same
  package. Build-time only; no runtime path found.
- **VAZ-13 — Web keeps message private keys unwrapped in IndexedDB, and keeps
  them after sign-out by default.** `frontend/src/lib/crypto/storage.ts`,
  `frontend/src/hooks/useAuth.ts:73-80`. A documented trade-off: script on the
  origin, or the next person at a shared browser, can read them. The CSP
  (`script-src 'self'`) is the mitigation. Consider forgetting keys by default
  when "keep me signed in" was not chosen.
- **VAZ-14 — Password-hashing pool.** `backend/src/utils/password.rs:40-41`:
  four workers, two-second queue. Sign-in attempts spread over several dozen
  addresses could keep it full, and real sign-ins would get 429. Not tested;
  Cloudflare sits in front.
- **VAZ-15 — One CSP report can write hundreds of log lines.**
  `backend/src/routes/csp_report.rs:172-196` (every entry of a report array is
  kept) and `:198-229` (one log line each). The endpoint is unauthenticated by
  nature. Run locally: an 8,173-byte body with 227 entries answered 204 and
  wrote 227 lines of about 259 bytes, 59 KB of log for 8 KB of request. The
  limiter allows 2 a second per address, and the container log keeps 30 MB
  (`docker-compose.prod.yml:3-7`), which is also where the `audit:` lines live.
  A few addresses could rotate recent audit lines out within minutes. Fix: log
  at most a handful of violations per request. Test: a 200-entry report yields
  no more than the cap.
- **VAZ-16 — The edge topology document contradicts the running host.**
  `nginx/README.md:1-6` says there is no Cloudflare Tunnel and no `cloudflared`
  service. On the host, `systemctl is-active cloudflared` answers `active` and
  the process runs `tunnel run`; `docs/security-audit-2026-09-23.md:133-135`
  describes traffic arriving only through the tunnel. The host files that
  restore the client address and gate the origin
  (`/etc/nginx/conf.d/cloudflare-realip.conf`, `cloudflare-origin-guard.conf`)
  trust loopback next to Cloudflare's ranges. A tunnel needs that; it also
  means any process on the host can state a client address to nginx. Nothing
  here is reachable from outside. It matters because the next reviewer reasons
  from the document. Fix: correct the README and record which path serves this
  hostname.

## 7. Five highest-priority improvements

1. Lock the account row on sign-in and re-check the password hash (VAZ-01).
2. Hide `avatar_url` in the block list, and centralize the visibility rule
   (VAZ-02).
3. Make "sign out everywhere" clear the feed token and push devices, and log
   feed changes (VAZ-03).
4. Turn orphaned grace-window tokens into tombstones (VAZ-04).
5. Give email change one uniform answer and trim the anonymous profile response
   (VAZ-05, VAZ-07).

## 8. Authentication and authorization

Sound, with the exceptions above. Verified by reading and, where marked, by
running:

- Argon2id (32 MiB, 3 passes), dummy verification for unknown addresses,
  breached-password check in production.
- Refresh, reset, verification, email-change and feed tokens are 256-512 bits
  from the OS generator, stored as SHA-256, single use.
- Access tokens: HS256 only, `sid` required, checked against an in-memory
  revocation cache rebuilt at startup; the event stream re-checks it.
- Lock after 5 failures, doubling to a day, shared by sign-in and every
  re-authentication. A third party who knows an address can still lock sign-in;
  the lock is not extendable and a reset clears it. Recorded as accepted.
- TOTP secrets encrypted with AES-256-GCM bound to the account; a step is
  accepted once.
- Every one of the handlers that take data calls `require_auth`; the
  unauthenticated set is the public pages, images, auth flows, health, the
  feed, CSP reports and push revocation. A sweep of every `UPDATE`/`DELETE`
  found none without an owner filter.
- Mass assignment: `PATCH /users/me` with `email_verified`, `is_moderator` or
  `avatar_url` answered 400 (run locally).
- Moderation requires a row in `moderators`, a verified email and two-factor;
  the runtime database role cannot write that table.
- No dynamic SQL from request input; the library filter is built once from
  constants.

## 9. Frontend and mobile

- Web: no `dangerouslySetInnerHTML`, `innerHTML` or `eval`; access token in
  memory only; `safeReturnTo` re-parses and compares the origin; no source maps
  in the build; the service worker excludes `/api/` and caches posters only.
- Server-rendered public pages escape every interpolated value, JSON-LD
  escapes `<`, `>` and `&`, and provider links are restricted to trusted HTTPS
  origins on the server.
- Mobile: refresh token and message keys in SecureStore
  (`THIS_DEVICE_ONLY`), `allowBackup: false`, cleartext off, App Links with
  `autoVerify`, post-auth redirects limited to four fixed path shapes, OTA off
  unless a code-signing certificate is configured.
  `crypto.getRandomValues` is filled from the platform generator.
- End-to-end encryption: X25519 + HKDF + AES-256-GCM per message, no forward
  secrecy (stated in the code), safety numbers derived from the keys in use,
  trust-on-first-use pins, recovery code of 100 bits behind Argon2id. Open
  points: VAZ-09, VAZ-13.
- No secret is bundled: only `VITE_API_URL`, `VITE_USE_R2_IMAGES` and their
  Expo equivalents.

## 10. Infrastructure and deployment

- Containers: non-root, read-only root, all capabilities dropped (Postgres
  keeps five it needs), `no-new-privileges`, memory and PID limits, loopback
  ports only, database on an internal network, images pinned by digest.
- Edge: Cloudflare-origin gate, real client address restored before rate
  limiting, per-route limits, 64 KiB default body, HSTS, `nosniff`,
  `X-Frame-Options: DENY`, COOP/CORP, CSP with `'self'` only for scripts and
  connections; the feed path is kept out of nginx and backend logs.
- `/metrics` requires a bearer token in production.
- CI: no `pull_request_target`, actions pinned by SHA, no auto-merge; deploy
  takes `origin/main` only with every check green.
- Backups: last run 2026-11-15 01:30 UTC succeeded, encrypted with age,
  dedicated credentials, off-site copy mirrored (`backup.prom`). Still open and
  already recorded in `docs/backup-credentials.md`: the age identity lives on
  the host it protects.
- No secret in tracked files or in history: gitleaks, at the version CI pins,
  scanned 890 commits and found none. `.env.prod`, its backups and the R2 key
  file are ignored, mode 600 and were never committed.
- The deployed images (`cinetrack-backend:latest`, `cinetrack-frontend:latest`)
  have no high or critical CVE under Trivy with the repository's
  `.trivyignore` (two accepted entries); the Dockerfiles have no high or
  critical misconfiguration.
- Host nginx, read without privileges: the deployed vhost is identical to
  `nginx/vazute.micutu.com.conf`; the real-IP file trusts loopback and
  Cloudflare's ranges and reads `CF-Connecting-IP`; the origin guard keys on
  the pre-rewrite peer address. See VAZ-16 for the tunnel.

## 11. Not verified, and what it would take

- **How the tunnel routes this hostname.** `/etc/cloudflared/config.yml` is
  readable by root only. Needs one privileged read of its ingress rules.
- **Firewall rules, Cloudflare account settings, R2 bucket policy and
  lifecycle as applied.** Need `ufw status` as root and the Cloudflare
  dashboard or an API token with read access to R2 and the zone.
- **VAZ-06 cost and memory under load.** The code path needs R2. Measuring it
  safely needs a scratch bucket with its own key and a stand-in for TMDB's
  image host, so that no load reaches the real one.
- **iOS configuration and the store builds.** Not built here; EAS builds run
  remotely. Needs the generated native projects or the build artifacts.
- **Co-tenant services on the host.** Outside this repository.

Everything else listed as open in the first draft of this report was closed in
the same pass: the remaining route modules were read in full, the history was
scanned, the images were scanned, and VAZ-01 was measured at release speed.

## 12. Tools and checks that actually ran

| Check | Result |
|---|---|
| `cargo audit` (443 crates) | 0 vulnerabilities; 1 ignored by `.cargo/audit.toml` (RUSTSEC-2026-0459) |
| `cargo deny check` | advisories, bans, licenses, sources ok |
| `cargo clippy --all-targets -- -D warnings` | clean |
| `cargo test --lib` | 445 passed, 0 failed, 1 ignored |
| `cargo build`, debug and release, at HEAD | ok, used for the local runs |
| CI check runs recorded for `fac206b` (read through the GitHub API) | all success: Backend, Backend Integration, Frontend, Frontend E2E, real-stack E2E, Mobile, Operations, Container Security, Gitleaks, CodeQL, Rust Audit, npm advisories |
| `scripts/npm_audit.py . moderate` (web) | pass; raw audit: 4 low |
| `npm run audit:high` (mobile) | pass; raw audit: 9 moderate, 10 low |
| gitleaks v8.30.1, the image and command CI pins, without network | 890 commits, no leaks |
| Trivy, the image `scripts/run_tests.sh` pins: deployed backend and frontend images, HIGH and CRITICAL | 0 and 0 |
| Trivy `config` on the tracked tree | 0 high or critical |
| Semgrep `p/default` on the tracked tree (624 files) | 14 hits, all reviewed: 13 in scripts and tests, 1 false positive (`frontend/src/App.tsx:84`, a same-origin path built from digits) |
| `scripts/check_secret_hygiene.sh` | pass, 1 warning (VAZ-11) |
| `edge_security_config_test.sh`, `crypto_core_parity_test.sh`, `calendar_feed_log_safety_test.sh`, `metrics_scrape_auth_test.sh`, `route_wiring_parity_test.py`, `account_export_contract_test.py`, `audit_exceptions_gate_test.py`, `npm_audit_test.py` | all pass |
| Local dynamic runs: throwaway tmpfs Postgres and the backend on loopback, synthetic accounts, removed afterwards | VAZ-01, 02, 03, 04, 05, 07, 08, 15 reproduced; VAZ-01 measured on the release build; mass assignment refused |
| Not run locally | the integration suite, Playwright and the web and mobile unit suites (green in CI for this commit); `ci_contract_test.sh`; the mobile native build |
| Not available | nothing that was needed; scanners missing as binaries were run from the pinned images already on the host, gitleaks after pulling the digest CI uses |
