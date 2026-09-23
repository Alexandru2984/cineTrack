# Security audit — 2026-09-23

Whole codebase and the running host, by class, with a dynamic phase against a
local instance on a throwaway database. The previous pass (2026-09-15) read the
code; since then the backend changed only in #242 (session grace window and
"keep me signed in") and #243 (recommendation seed), so those got the closest
reading, and every class was re-attacked from the outside regardless.

Three findings, all fixed in the same change as this document. Everything else
below was checked and is recorded as clean, with the evidence.

## Findings

### 1. Grace-window retries signed the account out of its other devices (medium, regression from #242)

Every refresh retried inside the 60 s grace window mints a new live token in the
same family. `cap_active_refresh_tokens` then kept the five newest live **rows**
per account, so a burst of retries on one device deleted the refresh tokens of
every other device: they were signed out on their next refresh, which is the
exact symptom #242 set out to fix. Siblings the client did not keep also stayed
valid until they expired, thirty days later.

Reproduced with 24 concurrent refreshes of one token: all answered 200, and the
account was left with 5 live rows, the other sessions gone.

Fix (`services/auth.rs`): the cap counts sessions (families), not rows. When a
token rotates normally, live siblings in its family older than the grace window
are deleted, because the client has just shown which one it kept. Siblings from
the same burst are left alone, so a token still on its way to the client is not
pulled from under it. Tests: `test_grace_retries_do_not_sign_out_other_devices`,
`test_rotation_prunes_tokens_orphaned_by_grace_retries`. Both fail on the
previous code and pass on the fix.

### 2. The login lock was visible through timing, which enumerated accounts (low)

A locked account was refused after a fixed 250 ms sleep, meant to stand in for
one Argon2 run. Measured on the release binary, the real run is faster:

| Case | Before (median) | After (median) |
|---|---|---|
| Unknown address, wrong password | 0.176 s | 0.147 s |
| Registered address, locked | 0.254 s | 0.145 s |

A few wrong guesses tip a registered address into the lock, after which it
answered about 75 ms slower than an address with no account: an enumeration
oracle through a code path that otherwise answers identically.

Fix: the locked path runs the same dummy Argon2 verification an unknown address
does, instead of sleeping. The submitted password is still never compared with
the real hash while locked, so the lock still cannot confirm a correct guess.
This spends no more CPU per request than an unknown address already costs.

### 3. The CSP allowed two analytics origins nothing uses (low)

`script-src` allowed `https://analytics.micutu.com` and
`https://static.cloudflareinsights.com`, and `connect-src` allowed those origins
plus `https://cloudflareinsights.com`. No page loads either one. The live HTML
has no beacon, and the repo has no reference outside the policy and the test
that pinned it. An allowed origin that the app does not use is only somewhere an
injected script could load from.

Fix: both directives are `'self'` only, in the repo and on the host. `nginx -t`
passed and nginx was reloaded. `edge_security_config_test.sh` now asserts that
both directives contain `'self'` and nothing else. Headless Chromium loaded four
pages of the live site with 0 CSP violations.

## Verified clean

**Origin forgery, CSRF, CORS.** Access tokens are bearer-only. The one cookie is
the refresh cookie: `HttpOnly`, `SameSite=Strict`, `Path=/api/auth`. With that
cookie, `/auth/refresh` and `/auth/logout` return 403, and consume or revoke
nothing, for each of these origins:
- a foreign origin;
- `null`;
- no origin;
- a suffix trick (`<origin>.evil.example`);
- a port trick;
- a scheme swap.

The same cookie with the real origin still refreshes. Login and register with
`text/plain`, form-encoded or multipart bodies (login CSRF) are refused, and no
cookie is set. Preflights from foreign, `null` and suffix-trick origins get no
`Access-Control-Allow-Origin`.

**IDOR, with each result confirmed in the database.** Of 141 routes, 59 take an
identifier. A second user was refused, with the row unchanged, on each of these:
- another user's tracking (PATCH, DELETE), history row, import job, list (GET
  private, PATCH, DELETE, add item), notification and session;
- accepting or rejecting a follow request addressed to someone else;
- a private profile's followers, following and activity, while the follow
  request is pending.

Profile JSON carries no private columns.

**Races, 24 concurrent requests each.** Each of these took effect exactly once:
- a reset token and a verification token;
- a message `client_nonce`.

The list quota held at 50. A refresh burst produced no 5xx, and the family was
not revoked.

**Injection and traversal.** 50 encoded traversal payloads across the three image
routes returned no 200, no 5xx and no file content. Among them: `%2e%2e`, double
encoding, `%5c`, overlong UTF-8, a NUL byte, and `/img/avatars/../../`. No
filesystem path is built from input. R2 keys are built only from a user id, a
parsed UUID, or a spec that passed the allowlist validator. SQL uses bound
parameters throughout. Headers and iCal were covered on 09-15 and have not
changed since.

**SSRF.** Outbound clients do not follow redirects, and path segments are
encoded. The mobile client's hosts are fixed. Unchanged since 09-15.

**Resources.** A 6 MB JSON body and a 200 000-deep nested array are refused, and
the server stays up. Hostile pagination and search parameters return 200 or 400,
never 5xx.

**Tokens.** The following are refused:
- `alg:none`;
- HS256 signed with an empty key;
- a tampered payload;
- an access token after its session logs out;
- an access token after a password change;
- a refresh token after logout.

**Exposure.** Production `/metrics` without its token returns 401. `.git`,
`.env` and other dotfiles return 403. No source maps, compose file or dump is
served: those paths fall through to the SPA shell. The headers include:
- HSTS with `includeSubDomains`;
- `nosniff`;
- `COOP` and `CORP: same-origin`;
- a restrictive `Permissions-Policy`.

**Host.** Only SSH (key-only, no root login) and coturn accept connections from
outside. nginx binds 80/443, but ufw drops both, and traffic arrives only through
the Cloudflare tunnel. coturn requires its shared secret, relays UDP only, and
denies loopback and every private range. Recommendation, not applied because the
service belongs to another app and a restart drops its calls: add
`denied-peer-ip=185.254.97.77`, the host's own address. Reachable through it
today are only cloudflared's connected QUIC sockets, which discard foreign
datagrams.

**CI and supply chain.** No `pull_request_target` or `workflow_run` trigger, and
no event text interpolated into `run:`. Every third-party action is pinned to a
SHA, and no PR-triggered workflow reads a secret. Write permissions exist only on
the scheduled advisory sweep. Auto-deploy takes only `origin/main` and requires
every check run and status to be green.

**Mobile.** The Android config has:
- `allowBackup: false`;
- cleartext traffic off;
- App Links with `autoVerify` (the live `assetlinks.json` lists the package and
  two signing fingerprints).

OTA updates cannot be enabled without a code-signing certificate, and never in
store builds. Private keys are overwritten in memory on sign-out (`wipeIdentity`,
#242).

## Second pass: line by line

The first pass above went through the codebase by vulnerability class, and the
2026-09-15 review said plainly that the backend had not been read line by line.
This pass did that. Every handler in the 22 route modules was read, along with the
auth, revocation, rate-limit and email services. Five sweeps then ran over the
whole backend:
- panic sites reachable from a request;
- DTO fields with no length bound;
- every `UPDATE` or `DELETE` without an ownership filter;
- free-form query parameters;
- slicing of user input.

The pass also covered:
- the web client: token storage, the login `returnTo`, dynamic `href`/`src`
  values, the service worker and query caching;
- the mobile client: deep links, reset-link handling, and the persisted query
  cache;
- the host's co-tenants.

Five more findings came out of it, all fixed and each with a test that fails on
the previous code. They were also reproduced against a local release build
before the fix and re-run after it.

### 4. A session that kept refreshing survived a password change (high)

Three flows revoke every refresh token of an account with
`UPDATE refresh_tokens ... WHERE user_id = $1`:
- password change;
- password reset;
- "sign out everywhere".

A rotation running at the same moment holds its token row. The `UPDATE` waits
on that row, but the successor the rotation inserts is not in the statement's
snapshot, so it is never revoked. A thief rotating a stolen token in a loop is
mid-rotation most of the time. **Measured: in 42 of 60 attempts the thief still
had a working session after the owner changed the password.** The access-token
cutoff does not cover this: it expires after 75 minutes, and the surviving
refresh token keeps working after that. Per-session revocation had already been
fixed for this race through `revoked_refresh_families`; the account-wide paths
had not.

Fix: rotation takes the account row `FOR SHARE` before its token. The four
revoking paths hold that row exclusively before touching `refresh_tokens`:
- password change and reset already updated the row first;
- logout and "sign out everywhere" now lock it (`lock_account_for_revocation`).

The lock order is the same on both sides, so they cannot deadlock. After the
fix: 0 of 60. Test: `test_a_password_change_ends_a_session_that_is_refreshing_in_a_loop`,
20 trials, which fails on the first trial against the old code.

### 5. Re-authentication was an unlimited password and second-factor oracle (medium)

Sign-in locks an account after 5 wrong passwords or codes. The confirmation
that sensitive actions ask for, `confirm_sensitive_action`, did neither: it
never checked the lock and never counted a failure. The actions that use it:
- changing the email or the password;
- turning off two-factor;
- deleting the account;
- replacing the encryption keys.

Two-factor setup had the same gap. With a stolen session and a phished password,
an attacker could walk the TOTP space through `/auth/email/change` and move the
account to their own address. Measured: 30 wrong codes, then 30 wrong
passwords; every one answered 401, and `failed_attempts` stayed at 0.

Fix: `reconfirm_password` and the second-factor check use the same counter and
lock as sign-in, and a locked account refuses the confirmation with 429. After
the fix: 5 × 401, then 429. Tests:
`test_second_factor_guesses_through_a_sensitive_action_lock_the_account` and
`test_password_guesses_through_a_sensitive_action_count_toward_the_lock`.

### 6. Deleting an account left its access tokens valid (low)

The cascade removed the refresh tokens. An access token already issued was
still accepted until it expired, because nothing added the account to the
revocation cache. Fix: `delete_account` calls `revoke_user` in the same
transaction. Test: `test_a_deleted_accounts_access_token_stops_working`.

### 7. A moderator could close a report about themselves (low)

Fix: a status change on a report whose subject is the acting moderator is
refused with 403, and the report stays open for another moderator. Test:
`a_moderator_cannot_close_a_report_about_themselves`.

### 8. The sign-in alert repeated the attacker's User-Agent (low)

The "new sign-in" email printed the raw User-Agent header. Whoever holds the
password chooses that header, so it could carry "this sign-in was blocked,
verify at <link>" inside a genuine Văzute security email. Fix: the email names
the device from a fixed vocabulary ("Chrome on Android", "Văzute app"). The raw
header never reaches the message. Unit test in `services/email.rs`.

### Verified clean in this pass

- **Client IP.** `conf.d/cloudflare-realip.conf` runs at the http level: it
  trusts cloudflared on loopback and Cloudflare's ranges, and reads
  `CF-Connecting-IP`, which the edge always overwrites. The vhost then
  overwrites `X-Forwarded-For` with `$remote_addr`, so the first entry the
  backend reads is the real client.
- **Handlers.** Every one of the 141 routes has the gate its data needs:
  - auth;
  - verified email;
  - current terms;
  - block checks;
  - privacy (`can_view_private_user`, `visible_connection_owner`).

  Every mutation without a `user_id` filter operates on the caller's own id, or
  on a row already proven to be owned in the same transaction.
- **Messages.** Blocks and the mutual follow are checked inside the transaction.
  Once both parties have keys, a send cannot drop to plaintext. Idempotency is
  scoped to the sender.
- **Key backup.** Readable with a session alone, but the recovery code carries
  100 bits (20 characters from a 32-symbol alphabet, no modulo bias) behind
  Argon2id, so it cannot be brute-forced offline.
- **Web client.** No tokens are kept in `localStorage`. `safeReturnTo`
  re-parses with `new URL` and compares the origin. The only external link goes
  through `safeWatchProviderLink`. The service worker caches TMDB posters only,
  and `/api/` is on its deny list.
- **Mobile client.** The persisted query cache is encrypted, holds only catalog
  and library roots (never messages or profiles), and is wiped on sign-out and
  account switch. The reset link lands on the sign-in screen and never signs
  anyone in.
- **Headers.** All ten path types checked carry CSP, HSTS, `nosniff` and
  `X-Frame-Options`, so no `location` drops the server-level headers.
- **Containers.** Every Văzute container runs:
  - as non-root;
  - with a read-only root filesystem;
  - with `cap_drop: ALL` and `no-new-privileges`;
  - under memory and PID limits;
  - on loopback-only ports.

  The production database is not published. Secret files are mode 600.
- **Co-tenants.** Portainer (which holds `docker.sock`) sits behind Cloudflare
  Access. The `hooks` webhook receiver requires an HMAC-SHA256 signature on all
  17 hooks, and passes static arguments only. `admin`, `analytics` and `uptime`
  have their own logins.

### Recommendations for the host, not applied

- **Dozzle** holds `docker.sock` and is protected by basic auth alone: one
  apr1-MD5 entry, and no rate limit on attempts. Actions and shell are off, so
  it reads logs only. Those logs include Văzute user ids, IPs and user agents.
  Put it behind Cloudflare Access, as Portainer already is.
- **coturn** denies loopback and private peers, but not the host's own public
  address. Add `denied-peer-ip=185.254.97.77`. Only cloudflared's connected
  QUIC sockets are reachable that way today.
- **Cloudflare Global API Key** in `~/cf_cred.env`: kept by the owner's
  decision, mode 600. Accepted.
