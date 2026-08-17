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

### Changed

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
- Blocking is enforced server-side across profiles, follows, activity, lists,
  notifications, and reports rather than being only a client-side filter.
- Report snapshots are bounded and moderator decisions require a recorded note.
- Moderator eligibility is checked from the database on every request and
  requires a verified email address plus enabled two-factor authentication.
- Community safety data has explicit least-privilege grants and bounded
  retention.
