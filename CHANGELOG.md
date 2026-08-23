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
  read them. Keys are generated on the device; the server holds two copies of
  the private key sealed by the account password and by a recovery code shown
  once, and can open neither. Losing both means losing access to encrypted
  history, because nobody else holds a key.
- Safety numbers, so two people can confirm through another channel that the
  key directory gave each of them the right key.
- Reporting an encrypted message. The reporter discloses that one message
  together with proof of what the sender wrote, so moderation still works on
  content the service cannot read.

### Changed

- The Terms of Service, Community Guidelines, and Privacy Policy describe how
  message encryption works, including the key material the service stores and
  cannot open. **The terms version moves to `2026-08-19`, so every existing
  user is asked to accept again on their next visit.**
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

### Security

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
- Credential files are audited by permission mode, not only by whether they are
  gitignored, closing a gap that left a live object-storage key world-readable
  on a host shared with unrelated services.
- The Prometheus scrape endpoint requires a bearer token. It was previously
  protected only by not being proxied, which is not a boundary on a host that
  publishes the application port beside unrelated services. `METRICS_BEARER_TOKEN`
  is required in production; see `docs/release-process.md` for the one-time
  setup a deploy needs before it will start.
- Blocking is enforced server-side across profiles, follows, activity, lists,
  notifications, and reports rather than being only a client-side filter.
- Report snapshots are bounded and moderator decisions require a recorded note.
- Moderator eligibility is checked from the database on every request and
  requires a verified email address plus enabled two-factor authentication.
- Community safety data has explicit least-privilege grants and bounded
  retention.
