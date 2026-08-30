# Security audit — 2026-08-30

Whole codebase, not a diff: ~100,000 lines across the Rust backend, the React
web client, the Expo mobile client, 62 migrations, 35 operational scripts, the
edge configuration and the CI workflows.

Every statement below was checked against the code and is cited by file and
line. Nothing here is inferred from a filename or a comment; where a comment
made a claim, the claim was tested against the implementation, and twice it did
not survive that.

## Method

- Enumerated all 140 registered backend routes by parsing the route tables, then
  extracted each handler body by brace matching and checked what it calls. An
  earlier regex-based pass reported the moderation handlers as ungated; that was
  a defect in the script, not the code, and is why the sweep was redone properly.
- Read every `UPDATE` and `DELETE` in the route layer, including multi-line
  `r#"…"#` queries, and checked each for an ownership predicate.
- Ran the dependency auditors and read the exception files, then re-verified the
  factual claims those exceptions rest on.
- Inspected the running production containers, not only the compose file.

## Verified clean

These were examined and no defect was found. Listed because "we looked" is part
of the result.

**Authorization.** All 140 routes swept. Every write in the route layer is
scoped to the caller: lists (`lists.rs:193,216,242,304`), profile
(`users.rs:322`), account deletion (`users.rs:841`), avatars
(`assets.rs:418,443`), calendar tokens (`calendar.rs:650,662`) — each binds the
id returned by `require_auth`, never one taken from the request. `get_list`
(`lists.rs:130`) fetches by bare id but then enforces blocking and privacy, and
answers a private list with 404 rather than 403, so it does not confirm
existence. Moderation is gated by `require_moderator`, and eligibility requires
both `email_verified` and `totp_enabled` (`moderation.rs:41`), so privileged
access cannot be held by an account without a second factor.

**Authentication.** JWT pins `Algorithm::HS256` and validates `exp`
(`utils/jwt.rs`); `sid` is a non-optional field, so a token without it fails to
deserialize rather than being treated as unrevocable. Login is uniform against
enumeration: one error string for every rejection, a dummy Argon2 run for
unknown accounts (`verify_password_or_dummy`), a response deadline, and locked
accounts refused *before* the password comparison so a correct guess against a
locked account is indistinguishable from a wrong one (`services/auth.rs:160-198`).
Lockout is 5 failures per 15 minutes for 15 minutes, and holds the counter at
the cap while locked so waiting out a lock does not buy a fresh batch of guesses
(`services/auth.rs:990-1030`).

**Two endpoints that authenticate without `require_auth` do so correctly.**
`POST /auth/mobile/sessions` authenticates by refresh token — validated, hashed,
required unconsumed, unrevoked and unexpired before it will list anything, and
only that user's sessions (`services/auth.rs:list_sessions_for_refresh_token`).
`POST /push/devices/revoke` authenticates by a capability secret rather than a
session, which is what lets an uninstalled app unregister.

**SQL injection.** No query is built with `format!`. All four `QueryBuilder`
sites (`importer.rs:474,503`, `tmdb.rs:1070,1205`) use `push_bind` for every
value; the only `push` is the literal `" ON CONFLICT DO NOTHING"`.

**XSS.** No `dangerouslySetInnerHTML`, `innerHTML`, `eval`, `new Function` or
`WebView` in either client. The only computed `href` values are `mailto:` with a
compile-time constant.

**SSRF.** Outbound hosts are fixed by configuration. The one endpoint selected
at runtime (`tmdb.rs:578`) is a `match` over three literals, and user search
terms go through `.query()`, which encodes them.

**Uploads.** Avatars are validated by magic bytes, the declared content type
must match the real one, dimensions and total pixels are capped against
decompression bombs, and metadata stripping fails closed — an image whose
container cannot be rewritten confidently is refused rather than stored with
EXIF intact (`assets.rs:validate_avatar_image`, `strip_avatar_metadata`). Size
limits are layered: nginx 64k default / 4M avatar / 25M import, application
JSON 64KB, avatar 3MB enforced while streaming, and the Expo push *response* is
capped at 1MB so a compromised upstream cannot exhaust memory.

**Secrets in logs.** Password-reset URLs are logged only when
`log_reset_urls: !config.is_production()` (`services/email.rs:36`). Audit lines
record user ids and event names, never credentials.

**Randomness.** Every secret comes from the OS RNG: refresh tokens 64 bytes,
calendar feed tokens 32, TOTP 20, password salts at the Argon2 recommended
length. The 8-byte value is a 2FA recovery code — 64 bits, which is sound
because it is hashed at rest and guarded by the login lockout above.

**Token storage.** Feed tokens and push unregister secrets are stored hashed, so
a database copy yields nothing usable. The web client keeps the access token in
memory only, and actively clears the key used by older versions
(`store/auth.ts:19`). The refresh cookie is `HttpOnly`, `Secure` in production,
`SameSite=Strict`, path-scoped.

**CI supply chain.** Every workflow declares `contents: read` and nothing more.
Every action is pinned to a full commit SHA. All nine checkouts set
`persist-credentials: false`. There is no `pull_request_target` or
`workflow_run`, so untrusted code never runs with elevated context — and **no
workflow references a single repository secret**, so there is nothing in CI to
steal. Deployment is pull-based from the VPS, which is why that is possible.

**Containers, as running in production.** The backend is
`gcr.io/distroless/cc-debian12:nonroot` and has no shell at all — `docker exec
sh` fails because there is no `sh` — so code execution there has nothing to
pivot with. The frontend runs as uid 101. The database container's PID 1 is
`postgres`, not root. All four drop `ALL` capabilities, set
`no-new-privileges`, cap pids, and publish only to `127.0.0.1`.

**Metrics.** The scrape credential is compared in constant time
(`middleware/metrics_auth.rs:tokens_match`), and production refuses to start
without one.

**Dependencies.** Frontend: zero advisories at any severity. Rust: one accepted
advisory, and its justification is *machine-checked* — the exception test fails
if a TLS or h2c bind ever appears in `main.rs`, or if the vhost stops proxying
over HTTP/1.1. That is the right shape for an exception.

## Findings

### 1. Mobile keeps the message keys readable while the phone is locked, and the file says otherwise

`mobile/src/lib/crypto/storage.ts:11` states the keys are "on a locked device
not readable at all". Line 85 stores them with
`AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`, which is readable whenever the device has
been unlocked once since boot — including while locked. Line 82 explains why
that was chosen, and the reason is real: background refresh needs the key, or a
notification arrives without the message it announces.

So the trade-off is defensible; the sentence eleven lines above it is not, and
the file contradicts itself. The same app stores the refresh token with the
stronger `WHEN_UNLOCKED_THIS_DEVICE_ONLY` (`secure-session.ts:10`) — and the
message keys are arguably the more sensitive of the two, because a token can be
revoked and a key decrypts history.

**Failure scenario.** A phone is taken while locked and its keychain is read by
an exploit that does not require the passcode. The refresh token is protected;
the message keys are not. Anyone who read the header comment while deciding
whether that risk was acceptable was told the opposite of the truth.

**Fix.** Either correct the comment, or move to `WHEN_UNLOCKED_THIS_DEVICE_ONLY`
and accept that a locked phone shows a notification it cannot yet decrypt. The
comment must change either way.

### 2. Messages are not authenticated before they are displayed

`#162` closed the send half: the server now verifies the sender's Ed25519
signature before storing, and records the key it verified against. The receiving
half is still open — neither client verifies a signature before rendering. There
is no `verify` call anywhere in `frontend/src/lib/crypto/` or
`mobile/src/lib/crypto/`.

**Failure scenario.** A compromised server hands a client a message it composed,
attributed to someone the reader trusts. The interface draws it exactly like a
real one. The signature that would expose this is present in the row and is
never checked until somebody files a report.

**Fix.** Verify the signature at decryption time and mark, or refuse, a message
that fails. The public key needed is already in the peer directory response.

### 3. An unreportable message is still displayed as if it were fine

`frontend/src/pages/Messages.tsx:199` renders the decrypted text and appends a
10px notice when `commitmentVerified` is false.

**Failure scenario.** A malicious sender encrypts abusive text A while
committing to innocuous text B. The victim reads A, and every report they file
fails verification, because the evidence opens to B. They are left with abuse
they cannot prove.

**Fix.** Do not render the plaintext when the commitment does not verify. Show
that the message is malformed and offer blocking — a message nobody can report
is itself the reportable event.

### 4. Key operations accept a plain access token

`routes/encryption.rs` gates key publication, backup replacement and backup
download with `require_auth` alone. No password or TOTP re-entry.

**Failure scenario.** A stolen access token is valid for fifteen minutes. In
that window it can overwrite the encrypted key backup — destroying the owner's
ability to recover their history — or download it for an offline attack on the
passphrase.

**Fix.** Require the existing password-plus-2FA confirmation for key replacement,
backup re-sealing and backup download, and send a notification email on key
rotation.

### 5. Any private IP is trusted to state the client's address

`middleware/rate_limit.rs:186` accepts `X-Forwarded-For` from any RFC1918 or
loopback peer.

**Failure scenario.** This VPS runs about seventy other sites and many
containers on private bridge networks. One compromised neighbour can present any
client IP it likes and spend somebody else's rate-limit budget, or evade its own.

**Fix.** Trust one address — the real nginx — rather than a range.

### 6. Avatar storage writes to R2 inside a database transaction

`routes/assets.rs:403-423` and `:437-447` call R2 while a transaction is open
and a `lock_user` row lock is held.

Two consequences. If R2 succeeds and the commit then fails, the object store and
the database disagree: an orphaned object, or a URL pointing at something that
no longer exists. And the user's row stays locked for the duration of a network
call to a third party, so an R2 slowdown becomes a lock queue.

**Fix.** Version the key, keep the transaction to the database write, and clean
up asynchronously.

### 7. Preview builds ship unsigned updates against the production API

`mobile/eas.json` sets `EXPO_UPDATES_ENABLED=true` for `preview` while
`EXPO_PUBLIC_API_URL` is `https://vazute.micutu.com`, and no code signing is
configured anywhere (the only `code-signing` strings in the repository are
transitive entries in `package-lock.json`).

**Failure scenario.** A compromised preview update reaches testers' devices and
runs against real accounts and real keys.

**Fix.** Sign updates, point preview at a staging backend, or disable OTA for
preview as production already does.

### 8. The audit exception's own re-check command has a blind spot

`mobile/scripts/check_audit_exceptions.py` accepts the `image-size` advisories
on the grounds that the vulnerable ICNS, JXL and HEIF decoders are unreachable
because the repository holds no such file, and documents a `find` to re-check.
That `find` prunes `./node_modules` but not `./mobile/node_modules`, and running
it today returns
`./mobile/node_modules/@react-native/debugger-shell/.../icon.icns`.

The conclusion still holds — Metro bundles `mobile/assets/`, which is three PNG
files, not an Electron resource — but the recipe written down for checking it
reports a hit, so the next person to run it learns nothing.

**Fix.** Prune both paths, or scope the search to the directories Metro reads.

### 9. Production is opt-in, and its absence selects the weaker configuration

`config.rs:62` defaults `APP_ENV` to `development`, which relaxes JWT secret
strength, CORS, the breached-password check, the metrics credential requirement
and reset-URL logging.

Mitigated in practice: `docker-compose.prod.yml:99` sets `APP_ENV: production` as
a literal, not an interpolation, so a missing `.env` value cannot downgrade it,
and `--check-config` runs before containers are replaced. Recorded because the
default points the wrong way, not because a path to exploit it was found.

## Corrections to the external audit of ecb748d

That audit was accurate on every point checked at the time. Two items have since
moved, and one of its supporting claims needs qualifying:

- Its finding 1 (safety number forgeable) is **fixed** — #161.
- Its finding 3 (rotation defeats reporting) is **fixed** — #162, which also
  closed the send half of finding 2.
- Its finding 7 described the mobile keychain comment as claiming keys are
  inaccessible on a locked device. That is right about the file header, but the
  comment at the call site states the trade-off correctly and gives the reason.
  The defect is the contradiction, not a uniformly false claim.

## Not verified here

State that lives outside the repository: whether the R2 bucket policy is
least-privilege, whether the Age escrow key exists off-host, and whether the
Play Console data-safety declaration matches the code. These need the consoles,
not the source.
