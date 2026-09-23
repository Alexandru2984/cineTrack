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
