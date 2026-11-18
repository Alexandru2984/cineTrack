# Changelog

All notable user-facing, operational, and security changes are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and release versions follow semantic versioning.

## [1.2.0] - Unreleased

### Added

- Complete Romanian and English interfaces across the web and native apps,
  including locale-aware dates, numbers, country names, and accessibility copy.
- Versioned Terms of Service and Community Guidelines with explicit acceptance
  before community features can be used.
- User blocking and reporting for profiles and public lists on web and mobile.
- A database-backed, two-factor-gated moderation queue with append-only
  decision auditing, retention controls, metrics, alerts, and an operator
  runbook.
- Automated WCAG A/AA scans and WebKit/iPhone coverage in the web E2E gate.
- End-to-end encrypted direct messages on web and mobile. Once both accounts
  have set up encryption, Văzute stores their messages without being able to
  read them. Keys are generated on the device; the server holds one copy of the
  private key, sealed by a recovery code that is generated on the device, shown
  once, and never sent. Losing that code means losing access to encrypted
  history, because nobody else holds a key.
- Safety numbers, so two people can confirm through another channel that the
  key directory gave each of them the right key.
- Badges earned from watch history: runs of one show in a sitting, episodes
  caught within a day of release, shows followed at once, and total episodes.
  They are recomputed from history rather than counted up, so removing episodes
  removes the badge they earned.
- Reporting an encrypted message. The reporter discloses that one message
  together with proof of what the sender wrote, so moderation still works on
  content the service cannot read.

### Changed

- Văzute moved to vazute.com. Pages on vazute.micutu.com and www.vazute.com
  redirect there permanently, path and query intact. The old host keeps
  serving the API, so installed Android builds and calendar subscriptions made
  before the move keep working, and the Android app opens links on both hosts.
  Web sessions are tied to the host, so everybody signs in once more on the
  new address. A web app installed from the old address replaces its service
  worker with one that unregisters itself and reloads into the new address.
  Mail is still sent from micutu.com.
- The Terms of Service, Community Guidelines, and Privacy Policy describe how
  message encryption works, including the key material the service stores and
  cannot open. **The terms version moves to `2026-08-19`, so every existing
  user is asked to accept again on their next visit.**
- Up Next no longer offers an episode before it has aired. Availability was
  decided by three different rules — the server's date, the server's date plus
  fourteen hours, and the date the client reported — and the last let a caller
  decide what counted as aired. There is now one rule, applied against the
  origin network's own clock, so an episode broadcast on Sunday night in the
  United States stops appearing on Saturday afternoon in Romania.
- Up Next prioritizes the most recently released eligible episodes before older
  backlog entries while preserving sequential episode progress.
- The native client is aligned with Expo SDK 57 and uses runtime `1.2.0`; this
  runtime must be distributed as a new native build, not as an update to an
  older runtime.
- Destructive and primary theme colors now use contrast-safe foreground pairs
  in light and dark modes.
- Release metadata is validated in CI before native compilation.

### Fixed

- Plan to Watch changes persist from touch-sized discovery cards on iOS/WebKit.
- Mobile web logout consistently lands on the clean sign-in route.
- Report dialogs trap keyboard focus, close with Escape, and restore focus to
  their trigger.
- Inline links no longer rely on color alone for identification.
- Message encryption can be turned on in the native app. Key generation read
  its randomness from `crypto.getRandomValues`, which React Native does not
  provide, so setup failed on every phone before anything reached the server;
  the app now supplies it from expo-crypto.

### Security

- The mobile app's build tooling takes minimatch 11.0.5, which fixes
  GHSA-g3hv-75wg-m249. @expo/fingerprint and the TypeScript ESLint parser are
  overridden onto it; the Expo fingerprint hashes are unchanged.
- picomatch GHSA-fc5q-39xc-vjpf has no fixed release yet. It is accepted, by
  version, in both audit gates: only build and test tooling carries it, and
  neither the site nor the app bundles it. The web audit gate now keeps
  reviewed exceptions under the same policy as the mobile one.
- The block list no longer shows a private account's photo. It was the one
  list that returned the avatar regardless of the account's privacy, and since
  blocking ends any follow between the two accounts, whoever blocked a private
  account could read its photo there and nowhere else.
- Viewed without signing in, a private profile no longer includes the account's
  id or the date it joined. It shows that the account exists and is private,
  which is what the link preview card for the same name already showed.
  Signed-in viewers still get the id, which reporting the account needs.
- The URL decoder behind deep-link routing no longer degrades on malformed
  input. `expo-router` parses links through `query-string`, which requires
  `decode-uri-component`; every published version it can load decodes malformed
  percent-encoding by recursing over splits of the token list, so cost climbs
  far faster than the length of the input — 1 200 characters took 7.5 seconds
  here, and kept climbing. A link crafted to exploit it would spin the app on
  whatever device opened it. The fixed upstream release is ESM-only and
  `query-string` is CommonJS, so it cannot simply be required; the fixed
  algorithm is vendored as CommonJS instead and wired in, with tests that check
  both the timing and that it agrees with upstream output.
- Two-factor recovery codes carry 80 bits instead of 64: sixteen base32
  characters in the same `xxxx-xxxx-xxxx-xxxx` shape. They are stored as
  unsalted SHA-256, so after a database leak their size is what keeps them out
  of reach. Codes can now be typed in capitals or without dashes, and codes
  issued before keep working. The native app accepts the new format from this
  release on; until then, a new code can be used on the web.
- On the web, a sign-in without "Keep me signed in" no longer leaves the
  message keys behind. They are stored unwrapped in the browser, and signing
  out kept them unless a second button was used, so a borrowed browser handed
  the next person every past message. Now they are removed on sign-out, or on
  the next visit after the browser was closed, and the sign-in form says so
  when the box is unticked. A kept sign-in still keeps them.
- The encrypted key backup is no longer sealed under the account password. It
  used to be sealed twice — once under a recovery code the server never sees,
  and once under a key derived from the account password, which the server
  receives in plaintext on every sign-in. That second copy was one the server
  could open, so "Văzute cannot read your messages" described how much work an
  operator would have to do rather than what the protocol allowed. New accounts
  store the recovery-code copy only. Accounts that already have the password
  copy keep it until their owner saves a fresh recovery code from Settings →
  Message encryption, which writes the new wrap and deletes the old copy in one
  transaction; taking it away on deploy would have locked out anyone who had
  mislaid their code. The cost is real and deliberate: restoring on a new device
  now needs the recovery code, and a forgotten password is no longer a way back
  in.
- One Content-Security-Policy report writes at most ten log lines, plus one
  line saying how many more it held. The endpoint takes reports without
  credentials, as browsers send them, and logged every entry of a report array:
  an 8 KB body of 227 entries wrote 59 KB into the container log that also
  keeps the `audit:` lines, so a few addresses could push those out within
  minutes. Every entry is still counted in the metric.
- Changing a password no longer carries a re-sealed key backup. Nothing is
  derived from the password any more, so there is nothing to re-seal — and the
  step that used to fail silently, leaving a backup sealed under a password
  nobody would use again, no longer exists.
- A stolen refresh token can no longer be used to take over a session quietly.
  Presenting a token again within a minute of its rotation is answered as a
  retry, so a thief who presented it just before the owner's app did got a
  session of their own, and the next rotation deleted the other side's copy:
  the owner looked signed out by expiry and nothing was flagged. That copy is
  now kept as used, so presenting it is reuse: every session on the account
  ends, and the event is logged and counted.
- A message's signature now names the sending and receiving accounts. It
  covered the commitment and nonce only, so anyone who knew a message's text
  and franking key, such as its recipient, could seal it to a third person and
  have it verify there as the sender's. The server checks the new layout at
  send and at report, and the apps check it against the conversation they are
  showing, not the ids written in the row. The old layout is refused rather
  than kept as a fallback; production held no encrypted messages when it
  changed. Builds of the Android app before this one can no longer send
  encrypted messages, and need updating.
- Plain-text messages are refused once both accounts have published keys. The
  choice between plain text and an encrypted envelope is made by the client,
  which is the only side that knows whether it can encrypt — so the server
  re-derives the same rule from its own key directory, and stripping the
  lookup is not a way to have plain text stored.
- Signing out, revoking a session, changing or resetting a password, and
  refresh-token reuse detection now take effect immediately. Previously they
  revoked only the refresh token, leaving an already-issued access token usable
  for the rest of its lifetime — up to fifteen minutes after the owner had
  deliberately cut off access. Access tokens carry a session identifier that is
  checked against a durable revocation record on every authenticated request.
  Access tokens issued before this change stop working when it is deployed;
  both clients recover automatically by refreshing.
- Asking to move an account to an address that another account already uses
  is answered exactly like a request for a free address. The answer used to be
  a 409 "already in use", given before the five-minute cooldown, so any
  signed-in account could test addresses one after another while sign-in and
  password reset take care to hide the same fact. Now the cooldown comes first,
  the request is recorded and the current address told as usual, and no
  confirmation link is sent, so the change can never complete.
- Usernames that read as the service or its staff (`admin`, `support`,
  `moderator`, anything containing `vazute` or `cinetrack`, and route names such
  as `search`) can no longer be registered or taken later, in any case and with
  or without `_` and `-`. No existing account held one.
- The native app's dependency gate fails on moderate advisories as well as high
  and critical ones. Nine moderate findings had gone unreported; all were one
  minimatch advisory in build and lint tooling, now accepted by name and pinned
  version so the next dependency move forces another look.
- Credential files are audited by permission mode, not only by whether they are
  gitignored, closing a gap that left a live object-storage key world-readable
  on a host shared with unrelated services.
- The Prometheus scrape endpoint requires a bearer token. It was previously
  protected only by not being proxied, which is not a boundary on a host that
  publishes the application port beside unrelated services. `METRICS_BEARER_TOKEN`
  is required in production; see `docs/release-process.md` for the one-time
  setup a deploy needs before it will start.
- "Sign out everywhere" also turns off the calendar feed link and removes push
  registrations, as a password change already did. Both work without a
  session, so a token held for a moment was enough to create either, and both
  kept delivering the owner's titles and air dates after the button. A pending
  email change or reset link is cancelled too. Creating or turning off a feed
  link now appears in the security timeline, and the timeline names the
  message-encryption events it used to show as a generic update.
- Blocking is enforced server-side across profiles, follows, activity, lists,
  notifications, and reports rather than being only a client-side filter.
- Report snapshots are bounded and moderator decisions require a recorded note.
- The public image proxy has a daily budget for images it has not stored yet:
  1,000 per address and 20,000 in all. Each new name used to cost a download
  from TMDB and a stored copy kept for 175 days, on a route that needs no
  sign-in, and a name TMDB does not have was asked for again every time. Names
  TMDB does not have are now remembered for an hour, only the image sizes the
  apps use are fetched (no more `original`, up to 15 MB each), cached images
  keep serving when the budget is spent, and an alert fires when it is.
- Sign-in can no longer be crowded out by a few dozen addresses. Every
  sign-in and registration costs an Argon2 hash from a pool of four workers,
  and each address's burst used to queue in full, so a coordinated burst left
  real sign-ins answering "busy". An address now holds at most two places in
  that pool, the rest of its burst is refused before hashing, and the edge
  allows sign-in and registration six times a minute per address instead of
  thirty.
- Moderator eligibility is checked from the database on every request and
  requires a verified email address plus enabled two-factor authentication.
- Community safety data has explicit least-privilege grants and bounded
  retention.
- A sign-in that was already in progress when the password changed, or was
  reset, no longer comes back with a working session. Sign-in checks the
  password, then issues the session; a change that committed between those two
  steps revoked every session that existed, but not the one about to be issued
  under the old password. The account row is now re-read and locked when the
  session is issued, so the sign-in either finishes before the change, which
  then revokes it, or sees the new password and is refused.
