# Security and reliability review — 2026-07-31

## Decision

**YELLOW — suitable for the current small beta, not yet for broad public
growth.**

No exploitable HIGH or CRITICAL application vulnerability remained confirmed
after remediation. Authentication, authorization, owner scoping, SQL binding,
token handling, upload/outbound-request limits, edge isolation, container
hardening, and the main abuse paths have both code review and regression-test
evidence.

The most urgent remaining work is operational: the VPS currently requires a
reboot and has pending security updates for OpenSSL, rclone, tzdata, and related
packages. Apply them in a maintenance window and run the production smoke checks
before adding users. Shared-host blast radius and weak host-compromise detection
also remain material.

Dedicated backup credentials and off-host Age-key escrow were explicitly
deferred by the repository owner and were not changed in this review. That is an
accepted exception for the current operator-created accounts, not a permanent
launch posture.

## Scope and limitations

This review covered:

- the Rust API, PostgreSQL migrations/roles, React web client, and Expo client;
- authentication, refresh rotation, TOTP, step-up actions, IDOR/ownership,
  validation, SQL construction, uploads, SSRF-style outbound requests, and
  sensitive logging;
- GitHub Actions, dependency state, lockfiles, SBOM generation, secret scanning,
  and production Dockerfiles;
- production containers, Nginx/Cloudflare origin controls, CORS behavior,
  monitoring, host firewall/SSH posture, and pending host updates, read-only;
- the local and CI test gates, including browser, real-stack, native-config,
  operational, and production-image checks.

It was not a destructive penetration test of Cloudflare, the VPS provider,
Expo, Apple, Google, Resend, TMDB, HIBP, R2, or Google Drive. No third-party
account was tested and no backup credential or encryption key was copied,
rotated, or inspected. Production data was not modified.

## Findings remediated

| Finding | Risk | Remediation and evidence |
| --- | --- | --- |
| RustSec `RUSTSEC-2026-0221` affected `event-listener 5.4.1`; the unsound API can violate thread-safety and lead to memory corruption | High potential impact | Locked `event-listener 5.4.2`, removed the obsolete transitive queue, and updated yanked `spin` releases. Raw `cargo audit` is now clean across 451 locked crates. Commit `76cfeb8`. |
| CI still carried a stale RustSec suppression | Medium control weakness | Removed every `cargo audit --ignore`; the workflow contract now rejects suppressed Rust advisories. Raw audit, Actionlint, ShellCheck, and the contract passed. Commit `7b96b95`. |
| Release builds had vulnerability reports but no retained component inventory | Medium supply-chain gap | Backend/frontend CycloneDX SBOMs, image IDs, and SHA-256 manifests are validated and retained as commit-bound CI artifacts for 30 days. Commit `1556a95`. |
| Dependency changes could merge without a change-scoped vulnerability policy | Medium supply-chain gap | Added a SHA-pinned dependency-review workflow that rejects MODERATE or higher runtime/development findings. Commit `8b23801`. |
| CI jobs had incomplete timeout/aggregate contracts | Medium availability/integrity gap | Added explicit timeouts, a tokenless aggregate `CI Gate`, full-SHA/action checkout contracts, serial DB-test enforcement, and SBOM/smoke contracts. Commit `9ed063f`. |
| The local gate did not match CI/release coverage | Medium release risk | The default runner now covers audits, builds, native config, operations, and serial PostgreSQL integration; `--full` adds all browser suites and production image/SBOM/Trivy checks with isolated dynamic ports. Commit `4a51c9a`. |
| Local WebKit silently depended on missing VPS GTK/GStreamer libraries | Medium coverage drift | Mocked Chromium/WebKit and PWA tests now run in a digest-pinned official Playwright image with the repository read-only and generated output confined to the disposable container. A contract enforces this. Commit `ef40b83`. |
| Repository and deployed edge policies could diverge | Medium configuration risk | Synchronized the strict production CSP and added executable checks for origin bypass, spoofed forwarding headers, request/rate/connection limits, token-safe logging, and exact host-vhost drift. Commit `d22db82`. |
| The public repository lacked a private disclosure policy | Low maturity gap | Added supported-version, private reporting, safe-testing, response-target, and coordinated-disclosure guidance. Commit `661a79b`. |
| The Android smoke test no longer satisfied the required terms gate | Release regression | Added a stable native identifier and made Maestro accept terms before registration. Mobile lint, TypeScript, and 154 tests passed. Commit `d047295`. |

## Residual risk and required actions

| Priority | Residual risk | Required exit |
| --- | --- | --- |
| P0 | The VPS reports `reboot-required=yes` and pending security updates, including OpenSSL and rclone | Schedule a maintenance window, update and reboot, then verify SSH, UFW, Docker health, public health/security headers, monitoring targets, backups, and application smoke flows. This review did not mutate the host. |
| P1 | CineTrack shares a VPS with unrelated services; the operator account has `sudo`/Docker-equivalent root and host intrusion MTTD is unbounded | Reduce unrelated public services or move the product to a dedicated trust boundary. Until then, add host/audit telemetry and rehearse full-secret rotation. `auditd` is currently inactive. |
| P1 — accepted/deferred | Backup writes still share application credentials and recovery depends on a host-held Age identity | When resumed: use the dedicated `backups` bucket with least-privilege credentials, escrow the identity off-host, restore into scratch, and record RPO/RTO. |
| P1 before public community growth | There is no demonstrated dedicated moderator account with verified email and TOTP | Enrol TOTP, grant the DB-backed moderator role, and rehearse the child-safety/threat runbook before advertising community features. |
| P2 | Branch protection requires review and existing checks, but administrators can bypass it; the new `CI Gate` and `Dependency Review` contexts are not required yet | After these commits are pushed and both contexts have run, add them to required checks. Enforcing rules for administrators would stop direct pushes and require a PR workflow; make that owner trade-off explicitly. |
| P2 | SSH TCP forwarding remains enabled | Disable it if no deployed workflow requires forwarding; otherwise document the dependency and constrain destinations/users. |
| P2 | Vendor DPA, transfer, retention, and security-review evidence is not present in the repository | Record current evidence for named subprocessors before material growth or monetization. |

Production evidence was otherwise healthy: application containers had no
restart/OOM signal, ran non-root/read-only with capabilities dropped, PostgreSQL
published no host port, and the application DB role was not a superuser. The
Cloudflare-only origin guard rejected direct and spoofed-origin access, CORS did
not authorize hostile/null origins, and TRACE returned 405. Current/rotated
Nginx logs contained no reset, verification, email-change, or calendar token in
query strings. Backend logs for the inspected 24-hour window contained no ERROR
or WARN entry. The only firing CineTrack alert was the explicitly deferred
shared-backup-credential alert.

## Six forcing questions

### 1. What are the three most credible loss scenarios?

1. A shared-VPS, SSH, Docker, kernel, or unrelated-service compromise exposes
   the database and every host-resident application secret.
2. Primary database loss plus deletion/corruption of recovery copies becomes
   unrecoverable because backup credentials and the Age identity are not yet
   operationally independent from this host.
3. A stolen password, refresh token, recovery code, or future moderator session
   exposes private viewing/social data or allows abuse of community workflows.

The application has meaningful controls for scenario 3. Scenarios 1 and 2 are
dominated by operational architecture rather than React/Rust code.

### 2. What is the blast radius?

The last measured production baseline on 2026-07-30 was three accounts, roughly
34,000 watch-history rows, and a database near 960 MB. An application-only
breach includes identities, social relationships, lists, ratings, viewing
history, session/security metadata, push tokens, and report evidence. Passwords
are Argon2id hashes and TOTP secrets are separately encrypted.

A host breach is wider: unrelated projects, environment files, SMTP/R2/TMDB
credentials, monitoring, build tooling, and the local recovery identity may all
require containment and rotation. This is the dominant blast radius.

### 3. What loss should be budgeted?

There is no revenue, contract, legal-cost, operator-hour, or incident-frequency
evidence from which to claim a real annualized loss. The previous review's
planning assumptions remain the only defensible placeholders:

| Scenario | Assumed annual probability | Assumed direct loss | Planning ALE range |
| --- | ---: | ---: | ---: |
| Shared-VPS compromise | 5–15% | EUR 5,000–25,000 | EUR 250–3,750 |
| Single-host database loss | 5–10% | EUR 2,000–15,000 | EUR 100–1,500 |
| One account takeover | 5–20% | EUR 250–2,000 | EUR 13–400 |

These are decision ranges, not forecasts, and must be replaced if usage,
revenue, staffing, contracts, or exposure to minors grows.

### 4. How quickly will the team know?

Known application signals—refresh reuse, recovery-code use, authentication
spikes, child-safety/threat reports, API failures, backup freshness, queue age,
and push/email failures—have metrics and alerts. The fastest security alerts
target MTTD under one minute from 15-second evaluation and a 30-second
Alertmanager grouping delay.

A quiet host compromise has unbounded MTTD: application metrics are not host
intrusion detection and `auditd` is inactive.

### 5. Can the team contain and recover?

The incident runbook covers global/per-account session revocation, JWT
invalidation, secret-rotation order, alerting reconfiguration, GDPR triage, and
safe restore commands. Containers are isolated and the restore tool refuses a
production overwrite without explicit confirmation.

Recovery remains plausible but unproven until a current off-host copy is
restored into scratch and measured. No current RPO, RTO, or tabletop MTTR should
be claimed.

### 6. Who owns residual risk and compliance?

The repository owner is currently operator, deployer, security contact, and
incident commander. That concentration is acceptable for the small beta but is
a key-person risk. The same owner accepts the temporary backup exception,
chooses whether branch rules apply to administrators, schedules the host patch
window, and maintains GDPR/vendor evidence. A second incident responder and an
operational 2FA-protected moderator are required as the product grows.

## Verification evidence

The complete local release gate passed after the fixes:

- 290 runnable backend tests passed; one credential-gated R2 round-trip remained
  intentionally ignored;
- all 118 PostgreSQL integration tests passed serially;
- 160 frontend tests, ESLint, TypeScript, production build, and npm production
  audit passed;
- 44 mocked Chromium/WebKit tests, 3 PWA install/offline tests, and 7 browser
  tests against a real Rust/PostgreSQL stack passed;
- 154 mobile tests, Expo lint, strict TypeScript, Android export, native prebuild
  validation, dependency policy, and Expo Doctor 20/20 passed;
- raw Cargo audit found no advisory across 451 locked crates;
- backend/frontend production images built successfully;
- digest-pinned Trivy found zero HIGH/CRITICAL vulnerabilities in both images,
  zero Dockerfile misconfigurations, and emitted valid CycloneDX inventories;
- Actionlint, ShellCheck, workflow contracts, embedded Python, backup/restore
  guards, edge/deployment checks, and all 29 Prometheus rules passed;
- digest-pinned gitleaks scanned the complete Git history and found no leak.

The review used the risk-paranoid CISO checklist. Its static-analysis helper
scripts were not present in the installed skill package, so the threat model and
six forcing questions above were completed manually from repository, runtime,
and test evidence.

No push, deploy, package upgrade, reboot, credential change, or production-data
write was performed.
