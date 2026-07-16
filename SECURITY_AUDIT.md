# CineTrack Security Audit

Date: 2026-07-16 (earlier rounds 2026-06-13 through 2026-07-14)

## Summary

The repo was already a solid MVP: parameterized SQL through `sqlx`, ownership checks on the main resources, Argon2 for passwords, signed JWTs, refresh tokens hashed in the DB, basic validation, and unit tests. The most significant gaps were around session handling, dependency hygiene, deployment hardening, and incomplete contracts between the API and the DB.

We fixed the issues carrying immediate risk: the refresh token is no longer exposed to JavaScript, rotation detects reuse, the JWT uses an explicit algorithm and a shorter lifetime, TMDB has a timeout, the rate limiter accounts for the reverse proxy, Nginx sends hardening headers, and CI runs lint/test/audit.

In the second round we closed the remaining gaps on the account and operations side: email normalization, password change/reset, active-session management, account deletion, CSP in Nginx, request-id plus Prometheus metrics, and supply-chain scanning (Dependabot, CodeQL, gitleaks). All new endpoints have integration tests that run against Postgres in CI.

In the third round we reviewed the repo directly on the VPS/prod host and closed three concrete risks: the npm high-severity vulnerability in `form-data` (via the lockfile), logging of the password-reset URL when SMTP is missing in production, and runtime hardening for the containers and Nginx. We also confirmed that `.env.prod` is untracked and `chmod 600`, and that the ports published in Compose are bound to `127.0.0.1`.

## Changes applied

- Rust backend cleaned up to pass `cargo clippy --all-targets -- -D warnings`.
- Dependencies reduced and `npm audit --omit=dev` brought down to 0 vulnerabilities.
- Refresh token rotation hardened with `consumed_at`, `revoked_at`, a transactional lock, and invalidation on reuse.
- Refresh token moved into an `HttpOnly`, `SameSite=Lax`, `Secure` (in production) cookie, with its path scoped to `/api/auth`.
- The frontend no longer persists the refresh token in `localStorage`.
- API validation extended for login, tracking, media type, rating, empty names, profiles, and lists.
- DB constraints added for statuses, media type, lengths, positive values, and date ordering.
- Private profiles no longer expose `bio` or `avatar_url` to unauthorized users.
- Common DB errors are mapped to 400/409 without leaking internal details.
- The TMDB client has a request timeout, connect timeout, user agent, and `error_for_status`.
- TMDB error logging avoids the full URL so the API key can't leak.
- The rate limiter uses `X-Forwarded-For` only when the peer is a private/loopback proxy.
- Nginx sends HSTS, `nosniff`, `DENY` framing, Referrer Policy, Permissions Policy, a body-size limit, and proxy timeouts.
- CI on GitHub Actions runs Rust fmt/clippy/test, frontend lint/test/build, `npm audit --omit=dev`, and `cargo audit`.

## Changes applied (2026-06-14)

- Email normalized (trim + lowercase) on register and login, plus a migration that normalizes existing rows so no duplicate accounts remain after a casing change.
- Authenticated endpoint `PATCH /api/auth/password` for changing the password with verification of the current password; it revokes all refresh tokens and clears the current session cookie.
- Password-reset flow: `POST /api/auth/password/forgot` (uniform response, no user enumeration) and `POST /api/auth/password/reset`. One-time tokens hashed with SHA-256, 1h TTL, consumed on use.
- Email delivery over SMTP configurable from env (`SMTP_HOST/PORT/USERNAME/PASSWORD/FROM`, using lettre with rustls); when SMTP is not configured, the reset link is only logged, so the flow doesn't break in dev.
- Session management: `user_agent`, `ip_address`, and `last_used_at` columns on refresh tokens; `GET /api/auth/sessions` (with a `current` flag), `DELETE /api/auth/sessions/{id}` (scoped to the owner, 404 on a foreign id), and `POST /api/auth/sessions/logout-all`.
- Account deletion: `DELETE /api/users/me` with password confirmation; cascades across all user-related tables and clears the cookie.
- The real IP used for sessions follows the same trust model as the rate limiter (`X-Forwarded-For` only from a private/loopback peer).
- Content-Security-Policy in Nginx, plus `Cross-Origin-Opener-Policy: same-origin`. The CSP allows only same-origin plus the analytics script and the TMDB images actually used; scripts stay strict, and `'unsafe-inline'` remains only for styles.
- Observability: a request-id middleware (a UUID per request; it ignores the value sent by the client, sets it in `X-Request-Id`, and includes it in the access log) and a Prometheus `/metrics` endpoint, served on the application port and not exposed through Nginx.
- Supply chain: `dependabot.yml` (cargo, npm, github-actions, docker), a CodeQL workflow for JS/TS, and a gitleaks workflow for secret scanning across the entire history.
- Frontend wired up to the new endpoints: public forgot/reset password pages (with a link from login), a Settings page for changing the password, an active-sessions list (per-session revocation and sign out all), and a danger zone for account deletion with password confirmation.
- Security and audit logging: `WARN` on refresh-token reuse (a signal of token theft, followed by revoking all sessions) and `INFO` audit lines on register, password change/reset, session revocation, sign out all, and account deletion. Only the `user_id` (UUID) is logged — no email/token/password.

## Changes applied (2026-06-20)

- Frontend supply chain: `npm audit --omit=dev` reported a high-severity vulnerability in `form-data` 4.0.0–4.0.5 via `axios`; the lockfile was updated so that `form-data` resolves to 4.0.6, and the npm audit is now clean.
- Reset-password logging: in production, if SMTP is not configured, the backend no longer logs `reset_url` (which contains the one-time token). In dev it stays log-only for debugging.
- Observability: the application logs use a task-local request id and are correlated with `X-Request-Id`/the access log, without accepting client-spoofed values.
- Runtime container hardening: `backend` and `frontend` in `docker-compose.prod.yml` run with `read_only`, `tmpfs` for the write directories they need, `no-new-privileges`, `cap_drop: ALL`, and `pids_limit`; Postgres gets `no-new-privileges` and `pids_limit`.
- Nginx hardening: `server_tokens off`, TLS limited to 1.2/1.3, explicit session cache/timeout, and `server_tokens off` on the internal SPA Nginx as well.
- Operational validation without leaking secrets: for Compose we use `docker compose config --no-env-resolution --no-interpolate --quiet` rather than plain `docker compose config`, because the latter can expose the values from `env_file`.

## Changes applied (2026-06-20, round 4)

- Build hygiene / secret-in-layer: added `.dockerignore` files for `backend` and `frontend`. Both Dockerfiles did `COPY . .` with no ignore, so the build context included `target/`, `node_modules/`, `dist/`, and any local `.env`; the contexts are now clean and a stray `.env` can no longer end up in an image layer.
- Onboarding without copy-pasting from the README: added a tracked `.env.example` that documents every variable read by the backend and by the compose files (with placeholders, not real values).
- Dead code removed: `GET /api/users/{username}/stats` and `/heatmap` were stubs that ignored the username and returned a hardcoded message pointing at `/api/stats/me`; unused by the frontend and not covered by tests, so they were removed (stats stay self-only).
- TMDB credential taken out of URLs: when `TMDB_READ_ACCESS_TOKEN` (v4) is set, the client sends it as an `Authorization: Bearer` header marked sensitive and drops `api_key` from the query string; it falls back to `api_key` when the token is missing or not header-safe, so existing deploys keep working. To enable it in production, add `TMDB_READ_ACCESS_TOKEN` to `.env.prod` and rebuild.
- Login-flow UX bug fixed (found via E2E): the axios interceptor treated any 401 as an expired access token and tried to refresh; on a wrong password the refresh (with no session) also responded 401, which logged the user out and redirected to `/login`, swallowing the "Invalid email or password" message. Now 401s from the auth endpoints (login/register/password) are surfaced directly so the form can display the error; refresh stays reserved for an expired token on other requests.
- E2E tests: the Playwright suite (`frontend/e2e`) covers route guards, the persisted auth store, login success/failure, logout, the refresh-on-401 interceptor against a dead session, and the uniform forgot-password confirmation. The backend is mocked at the network layer (no DB/API), so it's deterministic; it runs as a separate CI job.
- Documentation accuracy: the test counts in the README were corrected (116 unit + 44 integration + 53 frontend), the CSP is described correctly as a domain allowlist, and an MIT `LICENSE` file was added in place of the vague "personal/educational use" note.
- Frontend resilience: added an application-level `ErrorBoundary` (around `<Routes>`, leaving the navbar outside) that catches render errors and shows a fallback with reload/home instead of tearing down the whole SPA. It resets on navigation (`key` on the pathname). Covered by unit tests (vitest) and E2E (a malformed discovery response leads to the fallback, not a blank screen).
- Real-stack E2E: the Playwright suite `frontend/e2e-realstack` runs against an actually-running backend + an ephemeral Postgres (no mocking), with Playwright starting the backend itself (`cargo run`) and vite dev. It covers registration with an `HttpOnly` refresh cookie, real access-token rotation through the cookie in the browser, the active-sessions list, account deletion (which blocks re-login), and password reset with the one-time token (read from the backend log, since SMTP is disabled). It runs as a separate CI job (`e2e-realstack`, with a Postgres service and the Rust toolchain).

## Changes applied (2026-07-07)

- Self-serve TV Time import (`POST /api/import/tvtime`, multipart): uploaded files are capped at 32 MB/file; the job runs in the background (`tokio::spawn`) with a single import per account (guarded on `import_jobs`). TVDB/IMDB→TMDB resolution and caching reuse `TmdbService`; no synthetic episodes are created (the clean, product-grade approach).
- Avatar upload (`POST`/`DELETE /api/users/me/avatar`): strict type validation (only `image/png|jpeg|webp|gif`) and size (≤3 MB); the R2 key is derived from `user_id`, with no user-controlled filename, so there is no path traversal. `avatar_url` stays under the `users_avatar_url_shape` constraint (absolute http/https only).
- Public asset proxy (`GET /api/assets/{key}`): serves ONLY the `avatars/` and `posters/` prefixes; private objects (`imports/`, `backups/`) are not reachable through it; it rejects keys containing `..`.
- Write-through poster cache (`GET /api/img/{size}/{path}`): the spec is validated against an allowlist of sizes and a safe path (no `..`, `:`, `//`), so it can't be used for SSRF — the fetch only targets the fixed TMDB base from config.
- R2 object storage (`services/storage.rs`): credentials live only in `.env.prod` (chmod 600, gitignored); the features are config-gated — without `R2_*`, storage is disabled and the app runs normally. DELETE is done via a presigned URL (rust-s3 signs a header-based DELETE incorrectly on R2 → 403).
- DB backup to R2 (`scripts/backup_to_r2.sh`): `pg_dump | gzip -> R2 backups/` with retention (14 days), run via cron (daily at 03:30); the dump is read-only against production.
- Deploy: Compose adapted for Docker Compose 2.40 (`deploy.resources.limits.pids` aligned with `pids_limit`) and the frontend tmpfs (`/var/cache/nginx`, `/var/run`) set writable for the `nginx` user (uid 101), otherwise read-only Nginx enters a crash loop.

## Changes applied (2026-07-13)

- TMDB images are cached in private R2 with strict size/path validation, bounded streaming downloads, content inspection, and lifecycle retention. Raw catalog exports and database backups are archived separately and are never served by the public asset proxy.
- A complete daily TMDB ID/title inventory is stored in PostgreSQL for local search. Import validation rejects duplicate IDs, malformed flags, invalid popularity values, blank/oversized titles, and control characters; C1 punctuation is repaired before the strict DB constraint is applied.
- Local title search excludes adult/video entries and requires authentication. Catalog-only results do not create rows in the hydrated `media` cache and avoid upstream TMDB calls when a local match exists.
- Detail hydration is limited to 200 sequential requests per day at four requests/second. It uses a database advisory lock, stops on provider/rate-limit failures, applies bounded retry backoff, refuses stale inventories, and revalidates successful entries every 30 days.
- Hydrated media now stores bounded TMDB translations and alternative titles in a constrained alias table. Search, detail, discovery, provider-cache keys, and frontend queries all honor a validated locale such as `ro-RO`; localized responses do not overwrite the canonical English title.
- Authenticated discovery is generated entirely from PostgreSQL. Recommendations weight completed/watching/favorite/high-rated genres, exclude every already-tracked title and adult/video entries, and fall back to the daily local popularity inventory for cold-start accounts. The legacy TMDB `/trending` path was removed.
- The dashboard now exposes horizontal, responsive shelves for personalized recommendations, popular movies, and popular shows. Tracking mutations invalidate discovery so the current title disappears from recommendations without waiting for cache expiry.
- Production rollout was preceded and followed by verified R2 backups (`cinetrack_20260713_194933.sql.gz` and `cinetrack_20260713_200203.sql.gz`). The initial alias backfill completed 200/200 requests with no transient, invalid, or not-found results and stored 5,993 aliases across 193 titles.
- The backend and frontend images run non-root with read-only filesystems, all Linux capabilities dropped, and no-new-privileges. Trivy reported zero HIGH/CRITICAL source, configuration, and image findings; gitleaks scanned 120 commits without a leak; Actionlint and Zizmor reported no workflow findings; ShellCheck is clean.
- Production validation covered 167 passing backend unit tests (one credential-gated R2 test ignored), 73 PostgreSQL integration tests, 64 frontend tests, and 13 mocked-browser Playwright tests. Clippy ran with warnings denied, the complete npm audit reported zero vulnerabilities, authenticated localized-search and personalized-discovery smoke tests passed, and the public discovery response completed in 113 ms during the rollout check.
- Transactional email is connected to the local Mailcow deployment through `mail.micutu.com:587` with certificate-validated STARTTLS and authenticated `noreply@micutu.com`. A production password-reset request was verified from API submission through SMTP acceptance and IMAP delivery; the temporary account and message were removed afterward.

## Changes applied (2026-07-14)

- Added a personalized release Calendar backed entirely by PostgreSQL. The authenticated request path never contacts TMDB; it only reads the locally cached episodes and regional movie dates belonging to titles in the current user's library.
- Calendar query inputs are bounded and validated: 100-row page maximum, 90/365-day windows, complete opaque cursors, an ISO-style two-letter country code, a local `today` value within one day of UTC, and specials excluded by default.
- Episode plan/watch actions use per-user/per-episode transaction locks and re-check library ownership. Planning is capped at 10,000 episodes per account, idempotent writes do not consume quota, and a database trigger removes a plan whenever any code path inserts matching watched history.
- Added a focused schedule worker that deduplicates tracked titles across accounts, caps each run, rate-paces requests, takes a global PostgreSQL advisory lock, applies retry backoff, and stops early on upstream/provider failures. Active shows refresh every six hours, ended shows weekly, future/recent planned movies daily, and older planned movies monthly after their initial regional-date cache.
- Regional movie dates are normalized into constrained PostgreSQL rows and selected according to each user's country preference (default `RO`). Missing future-season detail now skips that season without discarding a valid show's current-season refresh.
- The global TMDB footer was removed. Required attribution now lives on a public About page with the exact non-endorsement notice, while application navigation remains focused on repeated tracking work.
- Full validation includes 175 passing backend unit tests, 76 PostgreSQL integration tests, 67 frontend tests, and 19 Playwright browser tests; the focused worker regression explicitly covers a not-yet-published season returning 404.

## Changes applied (2026-07-16)

- Removed the 30-day cutoff from the personalized unwatched feed. Keyset pagination remains bounded to 50 rows per request, and the frontend fetches the next page only as the user approaches the end of the rendered list. The recent-episode badge keeps its 30-day meaning.
- Added show progress and idempotent bulk-history endpoints for an aired season and for every regular-season episode through a selected episode. Specials are only included when explicitly targeting season 0.
- Bulk writes take the established per-user tracking lock before the history lock, calculate the exact additional quota under that lock, and insert all missing history rows in one transaction. Concurrent identical requests cannot create duplicate first-watch events.
- A bulk request is capped at 100 seasons and 10,000 episodes, and stale/missing season data is refreshed with concurrency limited to two provider requests. Provider/cache failure can leave metadata refreshed but cannot leave partial user history.
- Marking an episode resumes `plan_to_watch`, `on_hold`, or `dropped` tracking as `watching`; completed shows remain completed. The existing database trigger clears matching episode plans for every inserted history event.
- Season-level actions exclude episodes with a known future air date. The watched-through action includes only the selected episode and regular-season episodes before it; future episodes after the selected point remain untouched.
- The show detail page displays watched/total season progress, asks whether to include earlier gaps, confirms season-wide writes, locks background scrolling in the modal, and invalidates History, Tracking, Stats, Activity, Discovery, and Calendar caches after success.
- The candidate frontend image initially exposed `curl`/`libcurl` 8.19.0-r0 findings for CVE-2026-5773 and CVE-2026-6276. The production Dockerfile now pins the rebuilt official Nginx digest with `curl`/`libcurl` 8.21.0-r0 and verifies all audited package versions locally; the image must pass a HIGH/CRITICAL Trivy gate before rollout.
- Valid TMDB season responses can exceed the generic 2 MiB API-body limit for long-running shows. Season detail now has an endpoint-specific 8 MiB streaming cap, while every other TMDB response remains capped at 2 MiB; regression tests cover both the larger valid response and rejection above the season limit.
- Added an installable PWA shell with adaptive/maskable icons, explicit update handling, safe-area-aware mobile navigation, offline launch, browser installation prompts, and the manual Safari path required on iPhone/iPad.
- Workbox precaches versioned application assets only. Navigation fallback explicitly denies `/api`, runtime caching is limited to public `image.tmdb.org` poster URLs with entry/age quotas, and a browser test verifies that no authenticated API URL reaches Cache Storage.
- Added `GET /api/calendar/up-next`, bounded to 20 results and authenticated through the existing middleware. A lateral query selects the earliest aired unwatched regular episode per non-dropped tracked show; planned state only prioritizes that sequential candidate, so a later saved episode cannot make Home skip earlier progress.
- The Up Next integration test verifies sequence order and cross-user isolation. The mobile browser test exercises the watched mutation, query invalidation, empty state, 40 px action targets, and a 320 px viewport without horizontal overflow.
- PWA production-build tests now run in CI alongside mocked and real-stack browser suites. iOS detection and prompt/manual/already-installed states have focused unit coverage.
- The application does not currently request TMDB Watch Providers or direct JustWatch offers. A visible JustWatch source link and attribution were nevertheless added to About with regression coverage, preserving the contractual guard before a future availability widget is introduced. The [TMDB Watch Providers terms](https://developer.themoviedb.org/reference/movie-watch-providers) require JustWatch attribution whenever that data is used, and a future widget must carry the source link next to the data.
- The PWA rollout source/config scan, 140-commit gitleaks scan, Actionlint, Zizmor, and ShellCheck runs were clean. Trivy 0.72.0 reported zero HIGH/CRITICAL findings in both candidate images, including vulnerabilities without a published fix.
- Added dedicated no-store native authentication endpoints. Register/login/refresh return the rotating refresh token only to native clients and never set a cookie; logout accepts the validated token body. The existing browser endpoints remain HttpOnly-cookie based.
- Added an Expo SDK 57 native client for iOS and Android. Refresh tokens use `WHEN_UNLOCKED_THIS_DEVICE_ONLY` SecureStore storage, access tokens remain memory-only, concurrent 401 responses share one refresh operation, and a failed rotation clears the local session.
- Native core flows cover Home/Up Next, the full new/upcoming Calendar, local catalog search, an infinitely paginated library, profile attribution, password recovery, season-wide watched actions, and the selected-episode prompt for including earlier gaps.
- Native poster and backdrop requests use the existing `/api/img` write-through R2 cache by default instead of contacting TMDB's image CDN directly. A development-only environment switch can fall back when the target backend has no R2 storage.
- Android prebuild validation confirmed the production package id and explicit removal of legacy storage, overlay, vibration, and unused biometric permissions. SecureStore backup exclusions remain active. iOS prebuild validation confirmed the bundle id, disabled arbitrary HTTP loads, the non-exempt-encryption declaration, and removal of the unused Face ID description.
- Mobile CI performs reproducible `npm ci`, lint, strict TypeScript, all 20 Expo Doctor checks, a HIGH/CRITICAL npm audit gate, and an Android Hermes export. Dependabot now tracks the mobile lockfile separately; Actionlint and Zizmor found no workflow issues.
- Current validation covers 177 passing backend unit tests, 78 PostgreSQL integration tests, 81 frontend tests, and 24 Playwright browser tests (16 mocked, 6 real-stack, 2 PWA). Mobile validation also passed lint, TypeScript, Expo Doctor 20/20, Android export, Android/iOS prebuild, staged gitleaks, and a Trivy HIGH/CRITICAL scan.
- Production rollout was bracketed by verified R2 snapshots `cinetrack_20260716_171248.sql.gz` and `cinetrack_20260716_171521.sql.gz`. Backend moved from image `bdf86c4af228` to `a8a51aa35000`; frontend moved from `0cd257b3383d` to `98d9451640f1`; PostgreSQL was not recreated.
- Live validation confirmed healthy read-only/non-root containers, the public health endpoint, a protected `401` on unauthenticated Up Next, the installable manifest, strict service-worker cache headers, HSTS/CSP, JustWatch/TMDB attribution at 390 px without overflow, and a service-worker-controlled offline launch. An authenticated temporary-account smoke test returned a valid empty Up Next feed, deleted the account successfully, and left zero `@example.invalid` users.
- The native-auth backend rollout was bracketed by verified R2 snapshots `cinetrack_20260716_175944.sql.gz` and `cinetrack_20260716_180117.sql.gz`. Backend moved from `a8a51aa35000` to `cdca69584b11`; frontend and PostgreSQL were not recreated, and the prior backend image remains locally available for rollback.
- Trivy 0.72.0 found zero HIGH/CRITICAL vulnerabilities or embedded secrets in the new backend image. The image contains no application secrets, runs as `nonroot:nonroot`, and the deployed container remains read-only with all capabilities dropped and `no-new-privileges`.
- A live native-session smoke test verified register `201`, authenticated `me` `200`, refresh rotation `200`, rejection of the consumed token `401`, logout `200`, rejection of the revoked token `401`, and account deletion `200`. Mobile auth responses carried `Cache-Control: no-store`/`Pragma: no-cache`, set no cookies, and the database contained zero temporary `@example.invalid` users afterward.
- Post-rollout health and R2 poster-cache checks returned `200`; backend logs contained no error, panic, or fatal entries. The only warning was the intentionally triggered refresh-token reuse detector, which revoked the temporary account's sessions as designed.
- EAS project `@micu984/vazute` (`b036a54f-066e-41e1-8c33-80f324d410fe`) produced the first signed Android internal preview build, `9d809f89-792c-43d7-8732-7173a78ac53c`, from commit `e38be8b`. EAS completed all 831 Gradle tasks successfully and produced package `com.micutu.vazute`, version `1.0.0`/versionCode `1`, with minSdk 24 and target/compile SDK 36.
- The 112,128,240-byte APK has SHA-256 `379d23fe19678e7778f93205ca984d89bf52c13476ab2a17fee2a100aac00b04`. ZIP validation found no corruption; `apksigner` verified APK Signature Scheme v2 with one RSA-2048 signer whose certificate SHA-256 is `2524d5b15425451e001c6b8e65a4f51958e5b0a34ca5350a4158bd7a1063600f`. The artifact contains the production HTTPS API origin, SecureStore backup exclusions, no credential-like filenames, and no secret-scanner findings.
- Final-manifest inspection found unused `USE_BIOMETRIC` and deprecated `USE_FINGERPRINT` permissions inherited through AndroidX. The app never enables SecureStore `requireAuthentication`, so both permissions are now blocked in commit `76ca89d`; CNG verification generated the expected `tools:node="remove"` entries. The first signed artifact predates this fix and must be superseded before release.

## Residual risks

- Calendar freshness depends on the scheduled worker and TMDB availability. The default 200-title run budget is intentionally bounded; monitor `release_schedule_sync_state` age/outcomes and the worker exit code before raising it.
- PostgreSQL is the live metadata/query store; R2 is only the durable object/archive layer. Treating R2 as the primary movie database would remove relational indexes and personalized joins, so disaster recovery still requires restoring an R2 database snapshot into PostgreSQL.
- A watched-through action may need to refresh many old seasons and can therefore take longer while TMDB is slow. The provider phase is bounded and the final history write is atomic, but it is still a synchronous user action.
- Manual bulk history uses the current timestamp because the application cannot infer when old episodes were actually watched. Large backfills therefore appear on the current activity day and affect watch-time statistics accordingly.
- Offline mode intentionally restores the application shell rather than persisting personalized API data. Users can open the installed app without a connection, but their library, Calendar, and mutations require the backend; this avoids leaving authenticated responses in shared browser caches.
- A signed Android internal preview APK now exists, but it has not been exercised on a physical device and predates the biometric-permission fix in `76ca89d`. A fresh Android artifact plus an iOS internal build still need device validation for networking, keyboard behavior, deep links, release-build UI, and eventual push handling.
- The Android signing key is EAS-managed and has not yet been exported into an encrypted offline recovery escrow. Record the certificate digest and back up the keystore outside the VPS before the first store release; never commit signing material.
- Native UI automation is not present yet. Backend integration tests cover the mobile token contract, while native screens currently rely on lint, strict typing, Expo Doctor, bundle export, and prebuild validation.
- The first native release covers the core tracking workflow, not the entire web surface. TV Time import, social/follow flows, avatar/privacy/session settings, detailed charts, and account deletion still require the PWA until they are ported.
- `npm audit` reports 11 moderate findings in Expo's build/configuration path through `@expo/config-plugins -> xcode@3.0.1 -> uuid@7.0.3`. There are zero high or critical findings. `npm audit fix --force` proposes an incompatible Expo downgrade, so CI gates HIGH/CRITICAL and the moderate tooling advisory must be tracked until Expo updates the chain.

- The asset proxy and enabled poster cache make the backend a serving path for images. A dedicated `R2_PUBLIC_BASE_URL`/CDN would remove that bandwidth from the API while keeping the bucket private to writes.
- The R2 keys in `.env.prod` are long-lived; rotate them periodically and scope the token's permissions to just the `vazute` bucket.
- Access tokens stay stateless until they expire. The default lifetime is 1h; `logout-all` and a password change revoke the refresh tokens, but an already-issued access token stays valid until it expires. Instant revocation would require token versioning or a denylist.
- The refresh cookie uses `SameSite=Lax`. That's fine for a same-site deploy, but if the frontend and API end up on entirely different sites it will need `SameSite=None; Secure` plus explicit CSRF protection.
- `current` for sessions is determined from the refresh cookie; a client that calls without the cookie (with only an access token) sees all sessions as non-current, but this is not a security issue.
- `/metrics` has no authentication; its protection is that it isn't proxied by Nginx, so it depends on the deploy network's isolation. If the backend port becomes directly reachable, the endpoint must be restricted.
- `cargo audit` reports `RUSTSEC-2023-0071` via `sqlx-mysql` metadata in the lockfile, even though the build uses only the `postgres` feature. CI ignores it explicitly; revisit when `sqlx` resolves the lockfile.
- `cargo audit` also reports transitive `spin` 0.9.8/0.10.0 releases as yanked (through Prometheus/SQLx metadata and AWS S3 dependencies). They have no RustSec advisory, but should be replaced when their upstream crates update.
- The SMTP mailbox uses a long-lived credential stored in the git-ignored `.env.prod` file. Keep the file at mode `0600`, rotate the mailbox password periodically, and recreate the backend atomically after each rotation.
- Browser E2E tests now exist at three levels: mocked (auth, mobile navigation, discovery/social UI, Up Next, error boundary, and episode backfill confirmation), production-build PWA (manifest, service worker, API-cache exclusion, offline launch), and real-stack (HttpOnly cookie, refresh rotation, private follows, sessions, account deletion, reset with token). Lists and general tracking edits remain covered only below the browser layer.
- The secrets in `.env.prod` must be rotated if they were shown in a terminal, logs, or an audit transcript. In particular, avoid `docker compose config` without `--no-env-resolution` on machines or sessions that can persist the output.

## Next recommendations

- Alert when the release worker stops early, accumulates repeated failures, or leaves active tracked shows stale for more than 12 hours.
- Add a CSRF token if the deployment goes cross-site or if you switch the refresh cookie to `SameSite=None`.
- Extend E2E toward the content flows (tracking, episodes, lists) if they become critical, on top of the auth flows already covered mock + real-stack.
- Produce a fresh Android internal EAS build from `76ca89d` or later plus the first iOS internal build, test each on at least one current and one older device class, then add Maestro or Detox coverage for login/rotation, Calendar pagination, watched-through confirmation, and logout.
- Add native push notifications for planned and newly released episodes only after token registration, consent, delivery retries, and account/device revocation are designed.
- Extend observability: propagate the request-id into the audit/error lines too (it currently appears only in the access log), and wire up alerts on `security: refresh token reuse` plus dashboards over the Prometheus metrics.
- Decide on the privacy policy for follower/following counts on private profiles; right now bio/avatar and activity are hidden, but the counters are not.
- Run the gitleaks/CodeQL report periodically and treat Dependabot PRs as part of maintenance.
- Rotate the JWT secret, the DB password, and the TMDB key after audit sessions where the values were accidentally shown. The DB password rotation must be done atomically: `ALTER USER`, update `.env.prod`, then recreate/restart the backend.

## Local checks

- `cargo fmt --check`
- `cargo clippy --all-targets -- -D warnings`
- `cargo test`
- Integration tests against Postgres: `TEST_DATABASE_URL=postgres://test_user:test_pass@127.0.0.1:55433/cinetrack_test cargo test --test api_tests -- --ignored --test-threads=1`
- `cargo audit --ignore RUSTSEC-2023-0071`
- `npm run lint`
- `npm test -- --run`
- `npm run build`
- `npm run test:e2e` (Playwright; it starts vite dev itself, backend mocked at the network layer)
- `npm run test:e2e:pwa` (Playwright against the production build; manifest, service worker and offline launch)
- `npm audit --omit=dev`
- `(cd mobile && npm ci && npm run verify && npm audit --audit-level=high && npm run export:android)`
- Native config generation: `(cd mobile && npx expo prebuild --platform android --no-install --clean)` and the equivalent iOS command; generated directories remain ignored.
- `docker run --rm -v "$PWD:/repo:ro" -w /repo rhysd/actionlint:latest`
- `docker run --rm -v "$PWD:/repo:ro" -w /repo ghcr.io/zizmorcore/zizmor:latest .`
- `docker run --rm -v "$PWD:/repo:ro" -w /repo koalaman/shellcheck:stable scripts/*.sh`
- Trivy source/config and candidate-image scans with HIGH/CRITICAL findings configured to fail the command.
- `docker compose -f docker-compose.prod.yml config --no-env-resolution --no-interpolate --quiet`
- `docker run --rm --add-host backend:127.0.0.1 --add-host frontend:127.0.0.1 -v "$PWD/nginx/nginx.conf:/etc/nginx/nginx.conf:ro" -v /tmp/cinetrack-nginx-ssl:/etc/nginx/ssl:ro nginx:alpine nginx -t`
- Nginx config validation: `nginx -t` (or in a container with dummy certificates)
- Secret scan: `docker run --rm -v "$PWD:/repo" zricethezav/gitleaks:v8.30.1 detect --source /repo --redact`
