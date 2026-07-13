# CineTrack Security Audit

Date: 2026-07-13 (earlier rounds 2026-06-13 through 2026-07-07)

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
- Production rollout was preceded and followed by verified R2 backups. The backend image runs non-root with a read-only filesystem, all Linux capabilities dropped, and no-new-privileges; Trivy reported zero HIGH/CRITICAL findings.
- Production validation covered 164 backend unit tests, 72 PostgreSQL integration tests, 62 frontend tests, Clippy with warnings denied, `npm audit`, authenticated local-search smoke tests, and concurrent hydration locking.

## Residual risks

- The asset proxy and enabled poster cache make the backend a serving path for images. A dedicated `R2_PUBLIC_BASE_URL`/CDN would remove that bandwidth from the API while keeping the bucket private to writes.
- The R2 keys in `.env.prod` are long-lived; rotate them periodically and scope the token's permissions to just the `vazute` bucket.
- Access tokens stay stateless until they expire. The default lifetime is 1h; `logout-all` and a password change revoke the refresh tokens, but an already-issued access token stays valid until it expires. Instant revocation would require token versioning or a denylist.
- The refresh cookie uses `SameSite=Lax`. That's fine for a same-site deploy, but if the frontend and API end up on entirely different sites it will need `SameSite=None; Secure` plus explicit CSRF protection.
- `current` for sessions is determined from the refresh cookie; a client that calls without the cookie (with only an access token) sees all sessions as non-current, but this is not a security issue.
- `/metrics` has no authentication; its protection is that it isn't proxied by Nginx, so it depends on the deploy network's isolation. If the backend port becomes directly reachable, the endpoint must be restricted.
- `cargo audit` reports `RUSTSEC-2023-0071` via `sqlx-mysql` metadata in the lockfile, even though the build uses only the `postgres` feature. CI ignores it explicitly; revisit when `sqlx` resolves the lockfile.
- SMTP is not configured in production, so password-reset emails cannot currently be delivered. Production correctly avoids logging the one-time reset URL, but the user-facing recovery flow remains operationally incomplete until SMTP is configured.
- Browser E2E tests now exist at two levels: mocked (login/logout/refresh-401/forgot-password/error-boundary) and real-stack (HttpOnly cookie, refresh rotation, sessions, account deletion, reset with token). The tracking/episodes/lists flows remain uncovered by E2E (covered only by the backend integration tests).
- The secrets in `.env.prod` must be rotated if they were shown in a terminal, logs, or an audit transcript. In particular, avoid `docker compose config` without `--no-env-resolution` on machines or sessions that can persist the output.

## Next recommendations

- Add a CSRF token if the deployment goes cross-site or if you switch the refresh cookie to `SameSite=None`.
- Extend E2E toward the content flows (tracking, episodes, lists) if they become critical, on top of the auth flows already covered mock + real-stack.
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
- `npm audit --omit=dev`
- `docker compose -f docker-compose.prod.yml config --no-env-resolution --no-interpolate --quiet`
- `docker run --rm --add-host backend:127.0.0.1 --add-host frontend:127.0.0.1 -v "$PWD/nginx/nginx.conf:/etc/nginx/nginx.conf:ro" -v /tmp/cinetrack-nginx-ssl:/etc/nginx/ssl:ro nginx:alpine nginx -t`
- Nginx config validation: `nginx -t` (or in a container with dummy certificates)
- Secret scan: `docker run --rm -v "$PWD:/repo" zricethezav/gitleaks:v8.30.1 detect --source /repo --redact`
