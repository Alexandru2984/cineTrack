# CISO release review — 2026-07-30

## Decision

**YELLOW — approved for the current small deployment after the pre-migration
snapshot, migration, and production smoke checks. Not approved for a broad
public launch yet.**

No exploitable HIGH or CRITICAL application vulnerability was confirmed. The
release adds a versioned terms gate, user blocking and reporting, a
database-backed moderator role requiring verified email plus 2FA, append-only
moderation decisions, bounded safety metrics, and operational alerts. The
remaining release blockers are recovery and operational maturity, not a known
React or Rust authorization bypass.

The repository owner explicitly deferred new backup credentials and off-host
Age-key work. That exception is acceptable for the current three-account
deployment because backups are encrypted and mirrored, but it must not silently
become the permanent posture.

## Evidence and scope

The review covered the Rust API, React web app, Expo mobile app, PostgreSQL
schema and roles, Nginx and Compose runtime boundaries, monitoring, backup and
restore scripts, GitHub Actions, dependency state, container images, legal
surfaces, and community-safety workflows.

Production was inspected read-only before deployment:

- 3 user accounts;
- 34,248 watch-history rows;
- PostgreSQL size 959,831,063 bytes;
- application and monitoring containers healthy;
- 29 Prometheus alert rules loaded;
- no user currently enrolled in TOTP;
- the new reporting/moderation migrations were not yet applied, as expected
  before this release.

The review does not claim a penetration test of Cloudflare, the VPS provider,
Expo, Apple, Google, Resend, TMDB, HIBP, or Google Drive.

## Six forcing questions

### 1. What are the three most credible loss scenarios?

1. **Shared-VPS compromise.** Access through SSH, Docker, another public
   service, or a kernel/runtime vulnerability can expose every CineTrack
   secret and database row on the host. Membership of the operator account in
   `sudo` and `docker` makes either path effectively root.
2. **Account takeover.** A stolen password, refresh token, recovery code, or
   moderator session can expose private activity and social data. Refresh
   rotation, Argon2id, lockout, optional TOTP, step-up authorization, session
   revocation, activity history, and alerts reduce but do not eliminate this
   risk.
3. **Unrecoverable database loss.** The database is single-host, and backup
   writes still share the application's R2 credential. An attacker reaching
   that credential could damage the primary recovery copy. Client-side Age
   encryption and the separately mirrored encrypted archive reduce
   confidentiality and availability risk.

Community abuse is a fourth material scenario. Reports now preserve a
server-side snapshot and decisions are append-only, but there is no operational
moderator until an account enables 2FA and receives the database role.

### 2. What is the blast radius?

An application-only database breach affects the three current account
identities, social graph, lists, ratings, watch history, session metadata,
security activity, and any safety reports. Passwords are Argon2id hashes; TOTP
secrets are encrypted separately. The direct database footprint is about
960 MB.

A host compromise is larger than CineTrack: unrelated services share the VPS,
and host-held environment files, SMTP credentials, R2 credentials, signing or
build tooling, and the local Age identity may all need rotation. This is the
dominant risk even though the current user count is small.

The report queue intentionally cannot suspend or delete an account. A stolen
moderator session can classify reports and read evidence, but cannot perform an
irreversible punishment through the moderation API.

### 3. What loss should be budgeted?

Repository evidence cannot establish real incident frequency, legal fees,
operator time value, or user-compensation exposure. The following ranges are
decision assumptions, not accounting forecasts, and the scenarios overlap:

| Scenario | Assumed annual probability | Assumed direct loss | Planning ALE range |
| --- | ---: | ---: | ---: |
| Shared-VPS compromise | 5–15% | EUR 5,000–25,000 | EUR 250–3,750 |
| Single-host database loss | 5–10% | EUR 2,000–15,000 | EUR 100–1,500 |
| One account takeover | 5–20% | EUR 250–2,000 | EUR 13–400 |

The upper host-compromise range is enough to justify dedicated backup
credentials, off-host key escrow, and a measured recovery drill before growth.
These figures must be replaced if the service gains revenue, employees,
contracts, minors at scale, or materially more users.

### 4. How quickly will the team know?

- Refresh-token replay, recovery-code use, child-safety reports, and credible
  threat reports target **MTTD under one minute**: 15-second
  scrape/evaluation plus Alertmanager's 30-second group wait.
- Backend outage, server errors, email failures, backup state, release-worker
  state, push delivery, and moderation queue age have dedicated alerts.
- Client failures are covered by bounded browser/mobile diagnostics and fatal
  mobile crash metrics.
- A quiet SSH, Docker, kernel, or unrelated-service compromise has **unbounded
  MTTD** with the current evidence. Application metrics are not host intrusion
  detection.

No alert contains a user, IP, token, report narrative, or device label.
Operational correlation uses restricted logs and UUID/request identifiers.

### 5. Can the team contain and recover?

The incident runbook contains session revocation, JWT invalidation, secret
rotation order, alerting reconfiguration, GDPR triage, backup verification, and
scratch-restore commands. The restore script refuses a production overwrite
without an explicit destructive confirmation.

Backups are daily, retained for 14 days, verified by size/hash/archive shape,
Age-encrypted before upload, and mirrored to Google Drive. However:

- the backup R2 credential is not yet independent from the application;
- the Age identity still requires confirmed off-host escrow;
- a full scratch restore and human incident tabletop have not produced measured
  RPO, RTO, or MTTR.

Until those drills exist, recovery is technically plausible but not
operationally proven.

### 6. Who owns the residual risk and compliance work?

The repository owner is the current operator, security contact, deployer, and
incident commander. That concentration is acceptable for a private beta, but
creates key-person risk.

Văzute processes account identifiers, profile data, social data, viewing
history, session/security metadata, push tokens, and report evidence. The GDPR
runbook requires every personal-data breach to be documented and, when risk is
likely, notification to ANSPDCP within 72 hours where feasible. High-risk
breaches also require communication to affected people without undue delay.

The privacy policy names Cloudflare, TMDB, Resend, Expo, Apple, Google/FCM/APNs,
HIBP, R2, and the encrypted Google Drive mirror. The repository does not prove
that current DPAs, transfer assessments, retention settings, or vendor security
reviews have been completed. Those are operator/legal evidence tasks, not code
claims.

Before opening community features to a wider audience, appoint at least one
verified moderator with 2FA, confirm the escalation contact, and rehearse the
child-safety/threat workflow without copying report evidence into ordinary
tickets or chat.

## Verified release gates

- Rust formatting and Clippy with warnings denied;
- 290 backend unit tests passed; the credential-gated R2 round trip remained
  intentionally ignored;
- all 118 PostgreSQL integration tests passed;
- 160 frontend tests, lint, TypeScript, and production build passed;
- 44 mocked browser tests passed on Chromium and WebKit/iPhone;
- 7 real-backend/PostgreSQL browser tests passed;
- 3 PWA install/offline tests passed;
- 154 mobile tests, lint, TypeScript, Android export, Expo dependency checks,
  and Expo Doctor 20/20 passed;
- npm production audit reported zero vulnerabilities;
- Cargo audit reported no vulnerability, with two documented transitive yanked
  `spin` advisories allowed because the lockfile is already on the patched
  dependency path;
- gitleaks scanned the complete 429-commit history without finding a secret;
- production backend and frontend images built successfully;
- Trivy 0.72.0, pinned to
  `sha256:cffe3f5161a47a6823fbd23d985795b3ed72a4c806da4c4df16266c02accdd6f`,
  found zero fixed HIGH or CRITICAL vulnerabilities in either production image;
- ShellCheck, Actionlint, embedded Python checks, backup/restore guards,
  Prometheus rule validation, edge-header checks, and deploy hardening checks
  passed.

The real-stack gate caught and fixed a malformed PostgreSQL aggregate `FILTER`
expression in the moderation metric. The query is now fallible rather than
silently swallowed and is executed explicitly by the PostgreSQL integration
suite.

## Required exits from YELLOW

1. Put database backups in the dedicated `backups` bucket using a
   write-only/least-privilege credential unavailable to the application, then
   clear `CineTrackBackupUsesSharedCredentials`.
2. Escrow the Age identity off-host and prove that the escrowed copy decrypts a
   current archive.
3. Restore a current archive into a scratch database, verify migrations and
   representative row counts, and record measured RPO/RTO.
4. Run a dated account-takeover plus host-compromise tabletop and record
   measured detection, containment, and notification decisions.
5. Enrol and grant at least one dedicated moderator account with verified email
   and TOTP before advertising public community features.
6. Reduce shared-host blast radius or explicitly accept it with compensating
   host intrusion detection and tested full-secret rotation.
7. Record DPA/transfer/retention evidence for the named subprocessors before
   meaningful public growth.

Passkeys, PostgreSQL PITR/WAL archiving, signed SBOM/provenance, and a second
incident responder remain the next material maturity improvements. They are not
required for the current three-account deployment, but become increasingly
important as the product grows.
