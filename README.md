# 🎬 Văzute

A personal movie and TV show tracker with social features, inspired by TV Time. Track what you watch, visualize your activity with a GitHub-style heatmap, and keep detailed stats on your viewing habits.

**Live at [vazute.micutu.com](https://vazute.micutu.com)**

![Rust](https://img.shields.io/badge/Rust-000000?style=flat&logo=rust&logoColor=white)
![React](https://img.shields.io/badge/React-61DAFB?style=flat&logo=react&logoColor=black)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?style=flat&logo=postgresql&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2496ED?style=flat&logo=docker&logoColor=white)

## Features

- **Track Movies & TV Shows** — Add to your watchlist, mark as watching/completed/dropped, rate and review
- **Episode Tracking** — Mark one episode, a full aired season, or every previous episode through a selected point
- **Release Calendar** — Work through the full unwatched episode backlog, browse regional upcoming releases, save episodes for later, and mark them watched in place
- **Up Next** — Continue with the earliest unwatched aired episode from each tracked show without skipping progress
- **Installable PWA** — Mobile-first navigation, adaptive app icons, safe-area support, explicit updates, iOS installation guidance, and an offline launch shell
- **Native Mobile Client** — Expo SDK 57 app for iOS and Android with rotating native sessions, Home, Calendar, Search, Library, Profile, season-wide watched actions, and watched-through confirmation
- **Activity Heatmap** — GitHub-style contribution calendar for your viewing history
- **Detailed Stats** — Total watch time, streak tracking, genre distribution, monthly activity charts
- **Yearly Wrapped** — A per-year recap: titles, hours, top genres, most-watched titles, monthly activity, and longest streak
- **Where to Watch** — Region-aware streaming/rent/buy availability on each title (TMDB Watch Providers, powered by JustWatch, cached in PostgreSQL)
- **TMDB Integration** — Search a daily local catalog and refresh focused metadata/release schedules through bounded background jobs
- **Import from TV Time** — Upload your TV Time export and bring over your whole library, episode history and rewatches (background job with progress + a matched/unmatched summary)
- **Profile Avatars** — Upload a profile picture (stored in Cloudflare R2)
- **Dark Mode** — Toggle between light and dark themes
- **Social Features** — Follow other users, approve or reject requests to private profiles, and create custom lists
- **Privacy Controls** — Toggle profile visibility; private profiles expose details and activity only to approved followers

## Tech Stack

### Backend
- **Rust** + **Actix-Web 4** — High-performance async web framework
- **SQLx** — Async PostgreSQL driver with compile-time checked queries
- **PostgreSQL 16** — Primary database
- **JWT** — Authentication with short-lived access tokens (15 min) + refresh token rotation
- **Argon2id** — Password hashing
- **actix-governor** — Rate limiting (global + auth-specific)
- **actix-multipart** — Streaming file uploads (imports, avatars)
- **TMDB API v3** — Movie/TV show metadata
- **Cloudflare R2** (`rust-s3`) — S3-compatible object storage for avatars, a TMDB poster cache, and DB backups (optional; features degrade cleanly when unset)

### Frontend
- **React 19** + **TypeScript** — UI framework
- **Vite 8** — Build tool
- **Vite PWA + Workbox** — Installable application shell with controlled offline caching
- **Vitest** — Unit testing framework
- **Tailwind CSS 4** — Styling
- **TanStack Query 5** — Server state management
- **Zustand 5** — Client state management
- **Recharts** — Statistics charts
- **react-calendar-heatmap** — Activity visualization

### Mobile
- **Expo SDK 57** + **React Native 0.86** — Managed native iOS and Android client
- **Expo Router** — File-based stacks and a five-tab application shell
- **Expo SecureStore** — Device-bound refresh-token storage; access tokens remain in memory
- **TanStack Query 5** + **Zustand 5** — Server state, mutation invalidation, and session state
- **EAS Build** — Development, internal preview, and production build profiles

### Infrastructure
- **Docker** + **Docker Compose** — Containerization with resource limits
- **Nginx** — Reverse proxy with SSL termination (Let's Encrypt)
- **Cloudflare R2** — Object storage; nightly `pg_dump` snapshots via a cron'd script
- Non-root containers (backend + frontend)

## Security

The application has been through multiple security audits. Key measures include:

- **Authentication** — Short-lived JWT access tokens (15 min) with SHA-256 hashed refresh tokens, automatic rotation, and per-user token cap (max 5 sessions)
- **Two-Factor Auth (TOTP)** — Optional RFC 6238 authenticator codes, gated at login after the password check; single-use recovery codes stored only as SHA-256 hashes; disabling requires the account password
- **Breached-Password Rejection** — Register/change/reset check the password against Have I Been Pwned via k-anonymity (only a 5-char SHA-1 prefix leaves the server; fail-open)
- **Email Verification** — One-time confirmation link on registration (hashed token, 24h TTL, resend cooldown); existing accounts grandfathered
- **Rate Limiting** — Global rate limiter (10 req/s, burst 50) + stricter auth-specific limiter (3 req/s, burst 10) to prevent brute-force
- **Password Policy** — Minimum 8 characters, must contain at least one letter and one digit, rejects all-same-character passwords
- **Input Validation** — All user inputs validated with length limits (bio 500, review 5000, list names 200, etc.) and content validation
- **Upload Safety** — Avatar bytes, structure, dimensions, declared type, and size are checked; imports have byte and record limits plus a two-job global concurrency cap; poster downloads are streamed through an uncredentialed, non-redirecting client with strict size limits
- **Storage Access Control** — The public asset proxy only serves validated images under `avatars/` and `posters/`; private backup objects are never reachable through it
- **Cache Discipline** — Search, discovery, and Calendar read from PostgreSQL; bounded workers refresh the daily catalog, selected details, and tracked release schedules without request-time Calendar calls to TMDB
- **Calendar Integrity** — Episode actions are owner-scoped and transactionally serialized; watched history is authoritative and a database trigger removes stale plans regardless of the write path
- **PWA Cache Privacy** — The service worker never caches `/api` responses; only versioned application assets and public TMDB poster URLs are eligible for offline storage
- **Native Session Isolation** — Web refresh tokens stay in HttpOnly cookies; native refresh tokens are returned only by dedicated no-store endpoints and saved in SecureStore, while access tokens are never persisted
- **Mobile Platform Hardening** — Android release manifests block legacy storage, overlay, vibration, and unused biometric permissions; iOS keeps arbitrary HTTP disabled and does not declare unused Face ID access
- **Data Attribution** — The public About page preserves the required TMDB notice and JustWatch source link; any future availability widget must repeat JustWatch attribution next to its data
- **Privacy** — Private profiles require an approved follow request before details or activity become visible; public user endpoints never expose emails; no user enumeration on register
- **Access Control** — Private lists return 404 to non-owners; all media endpoints require authentication; history entries validated against existing media
- **Storage Quotas** — Per-account limits of 10,000 tracked titles, 10,000 planned episodes, and 100,000 watch events are enforced atomically across API requests and imports
- **Security Headers** — HSTS, X-Frame-Options (DENY), X-Content-Type-Options, Referrer-Policy, Permissions-Policy, and a same-origin-only script/connect Content-Security-Policy
- **Container Security** — Both backend and frontend run as non-root users; Docker resource limits enforced
- **Error Handling** — Internal errors (TMDB, JWT) sanitized before reaching client; no stack traces or implementation details leaked
- **Secrets** — Cryptographically generated JWT secret (64 bytes) and DB password; `.env.prod` is `chmod 600` and `.gitignore`'d

## Getting Started

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) & Docker Compose
- [TMDB API Key](https://developer.themoviedb.org/docs/getting-started) (free)

### Setup

1. **Clone the repo**
   ```bash
   git clone https://github.com/Alexandru2984/cineTrack.git
   cd cineTrack
   ```

2. **Create `.env`** with the following variables:
   ```env
   APP_ENV=development
   APP_HOST=0.0.0.0
   APP_PORT=8080
   FRONTEND_URL=http://localhost:5173

   POSTGRES_HOST=db
   POSTGRES_PORT=5432
   POSTGRES_DB=cinetrack
   POSTGRES_USER=cinetrack_user
   POSTGRES_PASSWORD=<generate-a-random-password>
   DATABASE_URL=postgresql://cinetrack_user:<password>@db:5432/cinetrack

   JWT_SECRET=<openssl rand -base64 64>
   JWT_EXPIRY_MINUTES=15
   JWT_REFRESH_EXPIRY_DAYS=30

   TMDB_API_KEY=<your-tmdb-api-key>
   TMDB_BASE_URL=https://api.themoviedb.org/3
   TMDB_IMAGE_BASE_URL=https://image.tmdb.org/t/p
   TMDB_TIMEOUT_SECONDS=10

   CORS_ALLOWED_ORIGINS=http://localhost:5173
   RATE_LIMIT_REQUESTS_PER_SECOND=10
   RATE_LIMIT_BURST_SIZE=50

   VITE_API_URL=http://localhost:8080

   # Cloudflare R2 object storage (optional — avatars, poster cache,
   # DB backups). Storage features are disabled if unset.
   R2_S3_API=https://<account-id>.r2.cloudflarestorage.com
   R2_ACCESS_KEY_ID=<r2-access-key-id>
   R2_SECRET_ACCESS_KEY=<r2-secret-access-key>
   R2_BUCKET=<bucket-name>
   # R2_PUBLIC_BASE_URL=   # set to a custom domain/CDN; unset => backend proxies assets
   # VITE_USE_R2_IMAGES=true   # opt in to serving posters via the R2 write-through cache
   ```

3. **Start the development stack**
   ```bash
   docker compose up -d
   ```

   The development stack uses the isolated `cinetrack-dev` Compose project and
   binds every published port to localhost. Start the optional DB UI separately:
   ```bash
   docker compose --profile tools up -d adminer
   ```

4. **Access the app**
   - Frontend: http://localhost:5173
   - Backend API: http://localhost:8080/api
   - Adminer (optional DB GUI): http://localhost:8081

### Production Deployment

```bash
# Create .env.prod with production values (use strong generated secrets!)
# Start PostgreSQL, provision separate runtime/migration roles, then deploy:
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d db
./scripts/provision_db_role.sh .env.prod
docker compose -f docker-compose.prod.yml --env-file .env.prod build backend frontend
docker compose -f docker-compose.prod.yml --env-file .env.prod run --rm --no-deps backend /usr/local/bin/cinetrack --check-config
docker compose -f docker-compose.prod.yml --env-file .env.prod run --rm --no-deps backend /usr/local/bin/cinetrack --check-smtp
docker compose --profile ops -f docker-compose.prod.yml --env-file .env.prod run --rm migrate
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d
```

- Production migrations are an explicit one-shot job and must complete before the backend is restarted. The web process only verifies embedded migration versions/checksums and refuses to start on a stale schema.
- The backend connects as `cinetrack_app`, a DML-only role without ownership, `CREATE`, `TEMP`, `TRUNCATE`, trigger, or reference privileges. `cinetrack_migrator` owns the application schema and is passed only to the one-shot migration job and daily catalog reconciliation.
- The bootstrap `POSTGRES_USER` credential is never passed to the application or migration containers.
- The `db` service uses a named volume, so rebuilding/redeploying does not touch existing data.
- Production containers run behind a host-level Nginx reverse proxy with SSL termination, as non-root users on a read-only root filesystem.
- The canonical host vhost is `nginx/vazute.micutu.com.conf`. Activate it through a symlink so `sites-enabled` cannot drift from the tracked configuration:

```bash
sudo install -o root -g root -m 0644 nginx/vazute.micutu.com.conf /etc/nginx/sites-available/vazute.micutu.com
sudo ln -sfn /etc/nginx/sites-available/vazute.micutu.com /etc/nginx/sites-enabled/vazute.micutu.com
sudo nginx -t
sudo systemctl reload nginx
```

### Local Development (without Docker)

**Backend:**
```bash
cd backend
# Ensure PostgreSQL is running and DATABASE_URL is set
cargo run
```

**Frontend:**
```bash
cd frontend
npm install
npm run dev
```

**Mobile:**
```bash
cd mobile
npm ci
cp .env.example .env.local
npm start
```

Native simulator/device builds require Android Studio or Xcode. See
[`mobile/README.md`](mobile/README.md) for EAS profiles and verification commands.

### Testing

The project has **411 passing unit & integration tests** (212 backend unit + 93 PostgreSQL integration + 106 frontend) plus **24 Playwright E2E tests** across three browser suites, and **53 mobile tests**. The native client additionally has lint, strict TypeScript, Expo Doctor, dependency-audit, prebuild, and Android-export gates. One credential-gated R2 test is ignored by default:

```bash
# Backend unit tests (201 passing) — no external dependencies
cd backend && cargo test --lib

# Frontend tests (97 passing) — Vitest + jsdom
cd frontend && npm test -- --run

# Backend integration tests (88 passing) — needs a test DB
docker compose -p cinetrack-test -f docker-compose.test.yml up -d --wait
cd backend && TEST_DATABASE_URL="postgres://test_user:test_pass@127.0.0.1:55433/cinetrack_test" \
  cargo test --test api_tests -- --ignored --test-threads=1
docker compose -p cinetrack-test -f docker-compose.test.yml down

# Frontend E2E — mocked backend, no DB needed (Playwright boots Vite itself)
cd frontend && npm run test:e2e

# PWA E2E — production build, manifest/service worker, API-cache exclusion, offline launch
cd frontend && npm run test:e2e:pwa

# Frontend E2E — real backend + ephemeral Postgres (Playwright boots both)
TEST_DB_PORT=55444 docker compose -f docker-compose.test.yml -p cinetrack_e2e up -d --wait
cd frontend && npm run test:e2e:realstack
docker compose -f docker-compose.test.yml -p cinetrack_e2e down -v

# Native client validation and Android bundle export
cd mobile && npm run verify && npm audit --audit-level=high && npm run export:android

# Or run everything at once:
./scripts/run_tests.sh
```

**What's tested:**
- **Unit tests** — JWT generation/validation, Argon2id hashing, password policy, all DTO validators (boundary cases, XSS rejection), error mapping & sanitization
- **Integration tests** — Full auth flows, access control, IDOR protection, user enumeration prevention, profile privacy, atomic tracking/history transitions, sequential Up Next selection, bulk episode history, Calendar ownership and pagination, release schedules, statistics, lists, and imports
- **Frontend tests** — Zustand stores, query hooks, utility functions, full-backlog Calendar pagination, Up Next actions, PWA lifecycle/install states, episode/season bulk controls, route contracts, About attribution, and error-boundary fallback
- **Mobile checks** — ESLint with React Compiler rules, strict TypeScript, all 20 Expo Doctor checks, reproducible `npm ci`, Android Hermes export, permission-aware Android/iOS prebuilds, and HIGH/CRITICAL dependency gates
- **E2E tests (Playwright)** — route guards, auth flows, mobile navigation, sequential episode actions, discovery/social UI, and watched-through confirmation against a mocked API; install/offline PWA behavior against a production build; plus a real-stack suite covering cookies, token rotation, sessions, account deletion, private follows, and password reset

## Project Structure

```
văzute/
├── backend/                # Rust + Actix-Web API
│   ├── migrations/         # SQLx database migrations
│   ├── tests/
│   │   └── api_tests.rs    # PostgreSQL integration tests
│   └── src/
│       ├── config.rs       # Environment configuration
│       ├── db.rs           # Database pool setup
│       ├── errors.rs       # Error types & sanitization
│       ├── lib.rs          # Library re-exports (for integration tests)
│       ├── main.rs         # Entry point, middleware wiring
│       ├── dto/            # Request/Response types + validation
│       │   ├── auth.rs     # Auth DTOs, password policy
│       │   ├── common.rs   # Shared pagination params
│       │   ├── social.rs   # Profile, list DTOs
│       │   ├── tracking.rs # Tracking DTOs
│       │   └── ...
│       ├── middleware/      # JWT auth extraction
│       ├── models/         # Database models
│       ├── routes/         # API route handlers
│       │   ├── calendar.rs # New/upcoming feeds, preferences, episode actions
│       │   ├── import.rs   # TV Time import (multipart -> background job)
│       │   ├── assets.rs   # Avatars, R2 asset proxy, poster cache
│       │   └── ...
│       ├── services/       # Business logic
│       │   ├── tmdb.rs     # TMDB client + media/season/episode caching
│       │   ├── release_schedule.rs # Focused tracked-title release sync
│       │   ├── importer.rs # TV Time -> TMDB resolution + import pipeline
│       │   ├── storage.rs  # Cloudflare R2 (S3) wrapper
│       │   └── ...
│       └── utils/          # JWT, password, refresh token helpers
├── frontend/               # React + Vite + TypeScript
│   └── src/
│       ├── components/     # UI components (Navbar, etc.)
│       ├── hooks/          # TanStack Query hooks
│       ├── pages/          # Route pages (including Calendar and About)
│       ├── store/          # Zustand stores (auth, theme)
│       ├── lib/            # API client with refresh interceptor
│       ├── test/           # Vitest setup and helpers
│       └── types/          # TypeScript interfaces
├── mobile/                 # Expo + React Native client
│   ├── src/app/            # Auth stack, tab screens, media details
│   ├── src/hooks/          # Native TanStack Query hooks
│   ├── src/lib/            # API, SecureStore session, formatting
│   ├── app.json            # iOS/Android identifiers and permissions
│   └── eas.json            # Development, preview, production profiles
├── scripts/
│   ├── run_tests.sh        # All-in-one test runner
│   ├── backup_to_r2.sh     # pg_dump -> gzip -> Cloudflare R2 (with retention)
│   ├── sync_tmdb_catalog.py # Daily TMDB ID/title inventory -> PostgreSQL + R2
│   ├── hydrate_tmdb_catalog.sh # Bounded popular-title detail hydration
│   └── sync_release_schedules.sh # Tracked-title episodes/releases -> PostgreSQL
├── nginx/                  # Internal reverse proxy config
├── docker-compose.yml      # Development stack
├── docker-compose.test.yml # Ephemeral test DB (tmpfs, port 55433 by default)
└── docker-compose.prod.yml # Production stack (with resource limits)
```

## API Overview

All endpoints except auth (register/login/refresh) require a valid JWT access token.

| Area | Endpoints |
|------|-----------|
| **Auth** | Web and native Register/Login/Logout/Refresh, Me, sessions, password reset, email verification (verify/resend), TOTP two-factor (setup/enable/disable) |
| **Media** | Local catalog search, localized details, Seasons/Episodes, personalized discovery, region-aware watch providers |
| **Calendar** | Sequential Up Next episodes, full unwatched backlog, upcoming episodes/movies, regional preferences, episode plan/watched actions |
| **Tracking** | CRUD for user's movie/show list with status, rating, review |
| **History** | Log watched episodes/movies, show season progress, mark a season watched, or backfill through an episode |
| **Stats** | Heatmap data, watch time, streaks, genre distribution, yearly Wrapped recap |
| **Users** | Public profiles, follow/unfollow, activity feed |
| **Notifications** | In-app inbox and unread badge counts |
| **Push** | Opt-in native release alerts: device registration and per-installation revocation (Expo Push) |
| **Diagnostics** | Authenticated, self-hosted mobile crash reports (redacted, rate-limited) |
| **Lists** | Custom user-created lists (public/private) |
| **Import** | Start a TV Time import (`POST /import/tvtime`, multipart); poll job status |
| **Avatars** | Upload / remove profile picture (`POST`/`DELETE /users/me/avatar`) |
| **Assets** | Public proxy for R2 objects (`GET /assets/{key}`); TMDB poster cache (`GET /img/{size}/{path}`) |

## Importing from TV Time

Users migrating from TV Time can bring their history in from **Settings → Import from TV Time**.

- **Input** — the browser-extension export (`shows.json`, `movies.json`) and, optionally, the GDPR `rewatched_episode.csv`.
- **ID resolution** — TV Time keys shows by **TVDB** id and movies by **IMDB** id; the app is **TMDB**-based, so the importer resolves each via TMDB's `/find` endpoint with a title-search fallback.
- **Matching** — episodes link by `(season, episode)`; for shows whose numbering diverges from TMDB (e.g. anime, or shows TV Time numbers by year), it falls back to **absolute-position** matching. Watches that TMDB can't represent are still recorded by date (they count toward the heatmap) and reported as "date-only".
- **Execution** — runs as a bounded background job (`import_jobs` table); the UI polls for status and shows a summary (shows / movies / episodes linked / date-only / unresolved). One non-failed import is reserved atomically per account, at most 100,000 watch events are accepted, and final tracking/history writes commit together under the same per-account quotas as the API.
- **Data minimization** — raw TV Time exports are parsed in memory and are not retained after the job is accepted.

## Object Storage & Backups (Cloudflare R2)

Object storage is **optional** — set the `R2_*` variables to enable it; without them the app runs normally and storage features are disabled. R2 is object/archive storage, not a relational query engine. Live catalog, episode, and regional release rows stay in PostgreSQL so personalized Calendar queries are indexed and fast; raw catalog exports and compressed database backups use R2 instead of permanent VPS file storage.

R2 is used for:

- **Avatars** — `avatars/{user_id}.{ext}`, served via the asset proxy (or a public domain if `R2_PUBLIC_BASE_URL` is set).
- **Poster cache** — an opt-in write-through cache (`VITE_USE_R2_IMAGES=true`) that mirrors TMDB images under `posters/` and serves them from `GET /api/img/{size}/{path}`.
- **Catalog exports** — compressed daily TMDB ID exports are archived under `catalog/exports/`; PostgreSQL keeps the compact, indexed current ID/title inventory while R2 holds the raw recovery copies.
- **Database backups** — `scripts/backup_to_r2.sh` runs `pg_dump | gzip` and uploads a timestamped snapshot to `backups/`, pruning anything older than the retention window (default 14 days). Schedule it with cron:
  ```cron
  30 3 * * * /path/to/cineTrack/scripts/backup_to_r2.sh >> /var/log/vazute-backup.log 2>&1
  ```

Apply the cache lifecycle rules once, then schedule the catalog sync after TMDB's daily exports are available. A second bounded job hydrates details for popular entries without scraping the entire catalog. The focused release job refreshes only distinct titles tracked by users and can run more often:

```bash
./scripts/configure_r2_lifecycle.sh
```

```cron
15 9 * * * /path/to/cineTrack/scripts/sync_tmdb_catalog.py >> /var/log/vazute-catalog.log 2>&1
0 10 * * * /path/to/cineTrack/scripts/hydrate_tmdb_catalog.sh >> /var/log/vazute-hydration.log 2>&1
20 * * * * /path/to/cineTrack/scripts/sync_release_schedules.sh >> /var/log/vazute-release-schedules.log 2>&1
```

## License

Released under the [MIT License](LICENSE).
