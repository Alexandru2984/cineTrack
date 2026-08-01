# Security and performance review — 2026-08-01

## Decision

**MITIGATE THEN SHIP for broad public growth. SHIP for the current
operator-created beta.**

No exploitable HIGH or CRITICAL application vulnerability was confirmed. The
full-history secret scan, Rust/npm advisory checks, source and Dockerfile
misconfiguration scans, manual trust-boundary review, and 119 PostgreSQL-backed
security/integration scenarios were clean. Authentication, refresh rotation,
TOTP replay protection, owner scoping, SQL binding, upload parsing, outbound
request restrictions, quotas, edge isolation, and security telemetry all have
code and test evidence.

The remaining launch risk is operational. CineTrack shares one VPS with many
unrelated services and `auditd` is inactive, so a quiet host compromise has a
large blast radius and potentially unbounded detection time. The host is fully
patched, UFW/fail2ban/AppArmor/unattended upgrades are active, SSH passwords and
root login are disabled, and the app containers are healthy and constrained.
Those controls reduce likelihood but do not create a separate trust boundary.

Dedicated backup credentials and off-host key escrow remain explicitly out of
scope at the owner's request. They are recorded as an accepted exception, not
silently treated as complete.

## Scope and method

The review covered the Rust/Actix API, PostgreSQL queries and roles, React/PWA
client, the relevant Expo interfaces, Nginx/Cloudflare edge, Docker production
images, GitHub Actions, dependency locks, monitoring, and read-only production
host posture. It used OWASP ASVS 5.0 as the application-control baseline and a
manual STRIDE/FAIR-style review for residual operational risk.

Primary references:

- [OWASP Application Security Verification Standard 5.0](https://owasp.org/www-project-application-security-verification-standard/)
- [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
- [GDPR Articles 33 and 34](https://eur-lex.europa.eu/legal-content/EN/TXT/?qid=1640080938208&uri=CELEX%3A32016R0679)

This was not a destructive penetration test of production or a third-party
provider. Production data was only counted in aggregate. No credential, backup
key, `.netrc` content, private message, email address, push token, or provider
account was read or changed. No push or deploy was performed.

## Changes made

| Change | Why | Measured result |
| --- | --- | --- |
| Capacity runner now treats crossing the latency budget as the expected test outcome and still runs the per-window analyzer | The old k6 threshold stopped the useful analysis and its summary crashed when p99 was absent | Repeated 800 req/s ramp completes deterministically and reports the last healthy window; commit `edc943a` |
| Benchmark seed now contains a recent, incomplete show and the mobile scenario rejects an empty Up Next response | The endpoint previously looked fast because the fixture returned zero items | Up Next returned 0.5 KiB at p95 26.82 ms; commit `3a67999` |
| Production backend binary is stripped in the builder stage | Debug/symbol data had no runtime value in the distroless image | Binary 35,971,208 -> 27,041,272 bytes; image 61,700,410 -> 50,687,938 bytes (17.8% smaller); commit `711b1f5` |
| Frontend build has reproducible transfer budgets in local and hosted CI | Bundle growth was measured manually but not prevented | Current initial gzip 154.2 KiB / 180 KiB; largest chunk 101.6 KiB / 120 KiB; all JS/CSS 335.2 KiB / 400 KiB; commit `401cf13` |
| Prometheus alerts on p95 latency and script-CSP spikes | Error-only monitoring misses a service that queues for seconds while still returning 200 | Promtool validates 31 rules; commit `ccdeca1` |

## Security findings

### Application and data controls

- Passwords use Argon2id with a fresh salt and bounded blocking concurrency.
  Correct and incorrect verification have comparable measured cost. The current
  configuration meets OWASP's minimum Argon2id memory/time recommendation.
- Access JWT validation fixes the algorithm to HS256 and requires subject and
  expiry. Refresh tokens contain 64 random bytes, are stored only as SHA-256
  hashes, rotate transactionally under `FOR UPDATE`, and revoke all account
  sessions on reuse.
- Browser refresh cookies are `HttpOnly`, `Secure` in production, `SameSite=Strict`,
  and scoped to `/api/auth`. Cookie refresh/logout requires an exact allowed
  Origin. Native clients use body tokens and do not depend on browser cookies.
- Password reset, email verification/change, recovery codes, and TOTP replay
  state are one-time and transactionally consumed. Credential changes revoke
  refresh sessions. An already-issued access JWT remains usable until its
  maximum 15-minute expiry; that is the deliberate residual window.
- Integration tests explicitly reject `alg=none`, SQL metacharacter injection,
  mass assignment, cross-account tracking/list/session/episode access, TOTP
  replay, brute-force attempts, invalid origins, and unowned session revocation.
- SQLx statements are parameterized. No dynamic SQL formatting, shell command
  execution, unsafe Rust, `eval`, `new Function`, `document.write`, or raw HTML
  injection was found.
- Outbound TMDB, HIBP, Expo, and object-storage calls use fixed/validated
  destinations, disabled redirects where appropriate, timeouts, and bounded
  bodies. Watch-provider URLs are reduced to allowed hosts.
- Avatar and poster routes validate key shape, extension, actual image header,
  dimensions, pixel count, declared type, and byte length. SVG is not accepted;
  public responses carry `nosniff` and immutable caching where appropriate.
- Persistent collections, imports, uploads, reports, social relationships,
  push devices, pagination, and bulk episode writes have explicit limits or
  atomic quotas.
- Production refuses an overprivileged runtime database role and detects stale
  or altered migrations. App containers run non-root, read-only, with all
  capabilities dropped and isolated networks; PostgreSQL has no host port.

### Automated evidence

| Control | Result |
| --- | --- |
| Cargo audit | 449 locked packages, no advisory |
| Cargo deny | Advisories, licenses, sources, and bans pass; duplicate transitive versions are reported but expected across the Actix/AWS/SQLx transition stack |
| Frontend npm audit | Runtime and full tree: zero vulnerabilities |
| Mobile high/critical policy | Pass; the one documented legacy advisory is constrained by the patched `brace-expansion` override |
| Gitleaks | 448 commits and about 5.18 MB scanned; no leak |
| Trivy config | Four Dockerfiles, zero HIGH/CRITICAL misconfiguration finding |
| Workflow review | Actions are immutable-SHA pinned, checkout credentials are disabled, permissions are minimal, and no `pull_request_target`, privileged workflow chaining, or inherited-secret pattern was found |
| Dynamic API suite | 119 passed serially against isolated PostgreSQL |

### Live posture sampled read-only

- Ubuntu 26.04 LTS on kernel 7.0.0-28 had zero pending package upgrades.
- UFW, fail2ban, AppArmor, and unattended upgrades were active. Unprivileged
  BPF was disabled; kernel pointer and dmesg restrictions were enabled.
- SSH root login, password authentication, keyboard-interactive authentication,
  X11 forwarding, and user environment injection were disabled. TCP and agent
  forwarding remain enabled.
- `.env.prod` mode was `0600`. The Docker socket is root/docker `0660`, which
  correctly implies that membership in the docker group is root-equivalent.
- All three CineTrack Prometheus targets were up. The only firing project alert
  was the explicitly deferred shared-backup-credential warning.
- Backend/frontend/database containers were healthy with zero restart/OOM
  signal. The backend and frontend were read-only/non-root/capability-dropped.
- Public TLS used a valid certificate; HSTS, CSP, clickjacking, MIME-sniffing,
  referrer, permissions, COOP/CORP, and origin-agent headers were present.
- One enforced inline-script CSP report was recorded from the currently
  deployed frontend. The repository fix already removes that inline script,
  but it will not become live until the owner pushes and deploys the pending
  commits.

## Threat model: three credible loss scenarios

| Scenario | STRIDE | Existing control | Blast radius | Detection / MTTD |
| --- | --- | --- | --- | --- |
| Stolen password, refresh token, recovery code, or moderator session | Spoofing, elevation, disclosure | Argon2id, login/account throttles, TOTP, refresh rotation/reuse revocation, session list/revocation, security email/activity | Normally one account: identity, private viewing data, social graph, lists, push devices; a moderator session adds report evidence and moderation actions | Reuse/lock/recovery/sensitive-action metrics evaluate every 15s and email after grouping; target under 1 minute for instrumented events. A stolen access JWT used normally can remain quiet for up to 15 minutes plus log-review delay. |
| Shared VPS, Docker socket, kernel, SSH, or unrelated service compromise | Elevation, tampering, disclosure, denial | Patched host, key-only SSH, fail2ban, UFW, AppArmor, non-root/read-only containers, network isolation, encrypted secrets/data elements | Dominant risk: all three Văzute accounts, 34,286 watch events, 1,756 tracking rows, a 965 MB DB, app/provider secrets, monitoring, and unrelated projects on the same host | Service failures are detected in minutes; a quiet host compromise has unbounded MTTD because `auditd`/host IDS is absent. |
| Malicious or compromised dependency/build action | Tampering, elevation, disclosure | Lockfiles/integrity, SHA-pinned Actions and images, dependency review, cargo/npm audits, source policy, full-history secret scan, SBOMs, tokenless aggregate gate | Source/release integrity and any CI secret available to the affected job; potentially production on a deploy workflow | Dependency PR and CI time for known advisories; unknown compromise depends on vendor/GitHub detection and review, so hours to days. |

## Indicative FAIR-style loss budget

There is no revenue, contractual liability, incident frequency, or response
cost history from which to derive an actuarial estimate. The following ranges
are decision aids only and deliberately wide:

| Scenario | Assumed annual probability | Assumed direct loss | Planning ALE |
| --- | ---: | ---: | ---: |
| Shared-host compromise | 2–10% | EUR 5,000–25,000 | EUR 100–2,500 |
| One account takeover | 5–20% | EUR 250–2,000 | EUR 13–400 |
| CI/dependency compromise | 1–5% | EUR 2,000–20,000 | EUR 20–1,000 |

At today's three operator-created accounts, reputation and operator time likely
dominate direct notification cost. These assumptions become invalid when the
product has paying users, minors, employees, advertisers, or material community
content.

## Detection and response

Application telemetry covers refresh reuse, recovery-code use, rejected-login
spikes, account locks, sensitive account activity, fatal clients, email errors,
backup/release health, moderation safety signals, 5xx rate, and now p95 latency
and script-CSP spikes. Prometheus scrapes/evaluates every 15 seconds and
Alertmanager groups normal alerts for 30 seconds.

Tabletop sequence for a stolen refresh token:

1. Critical refresh-reuse alert arrives; record awareness time and request ID.
2. Confirm automatic all-session revocation and inspect the account-scoped
   security activity without copying tokens into tickets/logs.
3. Invalidate credentials/JWT secret if scope is uncertain, notify the account,
   and preserve relevant proxy/app/database evidence.
4. Classify affected data and people. If the breach is likely to risk people's
   rights, notify ANSPDCP where feasible within 72 hours of awareness; if high
   risk, notify affected people without undue delay.
5. Restore service, verify the alert path, and add the missing detection that
   would have shortened the incident.

Tabletop sequence for a host compromise:

1. Isolate the VPS at the provider/firewall layer; do not trust host-local
   binaries, logs, backups, or environment files after that point.
2. Preserve provider/disk/network evidence, build a clean replacement host,
   revoke all sessions, and rotate signing, database, SMTP, R2, TMDB, Expo,
   GitHub/deploy, monitoring, and SSH material in dependency order.
3. Restore only from verified data, run migrations/readiness/smoke tests, then
   re-enable traffic. Treat every other project on the host as in scope.

The repository incident runbook already contains the operational commands and
GDPR decision record. A new Prometheus rules file must be deployed by recreating
the Prometheus container because its single-file bind mount can retain the old
inode after an editor replaces the file.

## Vendor and supply-chain review

| Provider | Data/trust | Failure or compromise effect | Current boundary |
| --- | --- | --- | --- |
| VPS provider | Entire host and encrypted/plain runtime data | Total service/data loss or disclosure | Host hardening and backups; no dedicated Văzute host |
| Cloudflare edge/R2 | Traffic metadata, cached images, avatars/object credentials | Availability, image disclosure/tampering, origin exposure if policy changes | Cloudflare-only origin guard, validated R2 endpoints/keys, bounded proxy |
| TMDB | Search/catalog identifiers and server requests | Discovery/schedule degradation; possible viewing-interest metadata | Server-side token, strict URL construction, no redirects, caching/timeouts |
| HIBP | First five SHA-1 password-hash characters | Password-strength check degradation; prefix metadata only | Fixed endpoint, no redirect, bounded response |
| SMTP provider | Recipient address and transactional security content | Notification outage or email metadata/content disclosure | TLS, timeouts, separate alert/transaction metrics |
| Expo push | Push token and notification payload | Push outage or metadata disclosure | Fixed Expo endpoints, bounded payloads/responses, revocable device records |
| GitHub/Actions | Source, build metadata, workflow tokens/secrets | Supply-chain/release compromise | SHA pins, minimal permissions, lock/audit/SBOM/secret gates |

Before material public growth, record current DPAs, locations/transfers,
retention, breach contacts, and deletion/export obligations for these providers.

## Performance results

### Backend and database

The benchmark stack used a release backend, isolated PostgreSQL, one backend CPU
limit, a freshly seeded heavy account (320 tracked titles, roughly 4,800
episodes and 3,800 watches), and background accounts so planner selectivity
resembles production.

| Path | Result |
| --- | ---: |
| Library screen payload | 39.7 KiB |
| Statistics screen payload | 8.4 KiB |
| Cold start API payload | 0.9 KiB |
| Tracking lists p95 | 3.97–4.00 ms |
| Episodes p95 | 7.84 ms |
| Wrapped p95 | 21.31 ms |
| Up Next p95 | 26.82 ms, non-empty |
| Stats summary p95 | 55.46 ms |
| SQL hot paths | 0.6–14.6 ms; all growing-table cases use indexes |
| Production five-minute API p95 at sample time | 4.75 ms at 0.032 req/s |

The capacity ramp sustained approximately **691 requests/second at p95 77 ms**
with zero HTTP failures, 429s, 5xxs, or pool timeouts. At the next stage the
service managed about 622 requests/second but queued to p95 3.2 seconds; the
overall run reached p99 12.1 seconds and dropped 1,882 offered iterations. This
is a saturation cliff, not proof that 800 req/s is healthy.

The data does not support blindly increasing the ten-connection SQL pool: no
pool acquire timeout occurred and indexed query latency remained low. More
connections on a one-CPU backend/database allocation can add contention. The
correct first action is the new latency alert, then CPU/DB observation under a
production-like load before tuning worker or pool counts.

The capacity number is intentionally limited: it is direct-to-backend,
read-heavy, excludes login/write/provider traffic, and ran on a shared VPS.
Argon2 sign-in capacity is much lower by design. Provider-cache misses are
bounded by the external service and were not represented by the dummy discovery
response.

### Crypto hot paths

| Operation | Typical result |
| --- | ---: |
| Argon2id hash | 39–41 ms |
| Correct password verify | 40–44 ms |
| Wrong password verify | 44–46 ms |
| JWT validate | 5.44 us |
| JWT sign | 3.52 us |
| Refresh token generate/hash | 1.04 / 2.46 us |
| TOTP accept/reject | 1.83 / 2.84 us |

The small correct/wrong Argon2 variance is within shared-host noise and does not
show a useful password-validity oracle. Authentication concurrency is bounded
so these deliberately expensive operations cannot occupy the whole runtime.

### Frontend and artifacts

- Initial HTML, entry graph, CSS, and theme bootstrap total 154.2 KiB gzip.
- The largest lazy route is Stats at 101.6 KiB gzip, primarily Recharts. It is
  not in the initial route, so replacing the chart stack is not justified now.
- All generated JavaScript and CSS total 335.2 KiB gzip. CI now fails at 180 KiB
  initial, 120 KiB largest chunk, or 400 KiB total.
- The PWA precaches 80 entries / about 1.13 MiB raw and excludes large launcher
  and social assets. Cloudflare served the sampled HTML with zstd; Nginx gzip is
  also enabled.
- `backend/target` occupies about 21 GiB locally, mostly debug dependencies and
  incremental objects. It is disposable build cache, not shipped product data.
  Run `cargo clean` only after the audit/full gate when reclaiming disk is worth
  the next full rebuild.

## Residual actions

| Priority | Action | Exit condition |
| --- | --- | --- |
| P1 before broad public launch | Add host audit/intrusion telemetry or move Văzute to a dedicated trust boundary | Demonstrated alerts for privileged login/process/file/container changes and a tabletop showing containment evidence survives host loss |
| P1 before public community growth | Create a dedicated verified moderator with TOTP | DB role, TOTP, recovery material, and child-safety/threat runbook rehearsed |
| P2 | Decide whether SSH TCP/agent forwarding is actually required | Disable both, or document/constrain the operator workflow that needs them |
| P2 | Require the aggregate CI Gate and Dependency Review checks after they have run on the pushed commits | Branch rule reports both required and a deliberately failing PR cannot merge |
| P2 | Retain vendor DPA/transfer/retention evidence | Current evidence and owners recorded before monetization/material growth |
| Deferred by owner | Dedicated backup credentials and off-host key escrow | Resume only when the owner reopens this scope |

## Final verification

The complete local `./scripts/run_tests.sh --full` release gate passed after all
code and documentation changes:

- 292 backend unit tests passed; Cargo audit and every Cargo deny policy passed.
- 160 frontend unit tests passed; lint, production build, bundle budgets, and
  both runtime/full npm audits passed.
- 156 mobile tests and all 20 Expo Doctor checks passed; typecheck, lint,
  dependency policy, Android export, and native production prebuild passed.
- 119 PostgreSQL-backed integration/security scenarios passed.
- Playwright passed 44 mocked-browser, 4 production-PWA, and 7 real-stack tests.
- CI, dependency-license/integrity, backup/restore, release, alerting, log-safety,
  edge-drift, and deployment-hardening contracts passed; Prometheus validated
  all 31 alert rules.
- Production backend and frontend images built successfully. Trivy reported zero
  vulnerabilities in both runtime images and zero misconfigurations in all four
  Dockerfiles.

Final gate result: **PASS**.
