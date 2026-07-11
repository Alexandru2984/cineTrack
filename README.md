# 🎬 Văzute

A personal movie and TV show tracker with social features, inspired by TV Time. Track what you watch, visualize your activity with a GitHub-style heatmap, and keep detailed stats on your viewing habits.

**Live at [vazute.micutu.com](https://vazute.micutu.com)**

![Rust](https://img.shields.io/badge/Rust-000000?style=flat&logo=rust&logoColor=white)
![React](https://img.shields.io/badge/React-61DAFB?style=flat&logo=react&logoColor=black)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?style=flat&logo=postgresql&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2496ED?style=flat&logo=docker&logoColor=white)

## Features

- **Track Movies & TV Shows** — Add to your watchlist, mark as watching/completed/dropped, rate and review
- **Episode Tracking** — Mark individual episodes as watched for TV series
- **Activity Heatmap** — GitHub-style contribution calendar for your viewing history
- **Detailed Stats** — Total watch time, streak tracking, genre distribution, monthly activity charts
- **TMDB Integration** — Search and browse movies/TV shows powered by The Movie Database API
- **Import from TV Time** — Upload your TV Time export and bring over your whole library, episode history and rewatches (background job with progress + a matched/unmatched summary)
- **Profile Avatars** — Upload a profile picture (stored in Cloudflare R2)
- **Dark Mode** — Toggle between light and dark themes
- **Social Features** — Follow other users, public/private profiles, custom lists
- **Privacy Controls** — Toggle profile visibility; private profiles hide activity from non-followers

## Tech Stack

### Backend
- **Rust** + **Actix-Web 4** — High-performance async web framework
- **SQLx** — Async PostgreSQL driver with compile-time checked queries
- **PostgreSQL 16** — Primary database
- **JWT** — Authentication with short-lived access tokens (1h) + refresh token rotation
- **Argon2id** — Password hashing
- **actix-governor** — Rate limiting (global + auth-specific)
- **actix-multipart** — Streaming file uploads (imports, avatars)
- **TMDB API v3** — Movie/TV show metadata
- **Cloudflare R2** (`rust-s3`) — S3-compatible object storage for avatars, import archives, a TMDB poster cache, and DB backups (optional; features degrade cleanly when unset)

### Frontend
- **React 19** + **TypeScript** — UI framework
- **Vite 8** — Build tool
- **Vitest** — Unit testing framework
- **Tailwind CSS 4** — Styling
- **TanStack Query 5** — Server state management
- **Zustand 5** — Client state management
- **Recharts** — Statistics charts
- **react-calendar-heatmap** — Activity visualization

### Infrastructure
- **Docker** + **Docker Compose** — Containerization with resource limits
- **Nginx** — Reverse proxy with SSL termination (Let's Encrypt)
- **Cloudflare R2** — Object storage; nightly `pg_dump` snapshots via a cron'd script
- Non-root containers (backend + frontend)

## Security

The application has been through multiple security audits. Key measures include:

- **Authentication** — Short-lived JWT access tokens (1h) with SHA-256 hashed refresh tokens, automatic rotation, and per-user token cap (max 5 sessions)
- **Rate Limiting** — Global rate limiter (10 req/s, burst 50) + stricter auth-specific limiter (3 req/s, burst 10) to prevent brute-force
- **Password Policy** — Minimum 8 characters, must contain at least one letter and one digit, rejects all-same-character passwords
- **Input Validation** — All user inputs validated with length limits (bio 500, review 5000, list names 200, etc.) and content validation
- **Upload Safety** — Avatar uploads are type- and size-checked (image types, ≤3 MB); import files are size-capped; the poster cache validates the `{size}/{path}` spec against a size allowlist and rejects traversal/host injection (no SSRF)
- **Storage Access Control** — The public asset proxy only serves the `avatars/` and `posters/` prefixes; private objects (`imports/`, `backups/`) are never reachable through it
- **Privacy** — Private profiles hide activity/followers from non-followers; public user endpoints never expose emails; no user enumeration on register
- **Access Control** — Private lists return 404 to non-owners; all media endpoints require authentication; history entries validated against existing media
- **Security Headers** — HSTS, X-Frame-Options (DENY), X-Content-Type-Options, Referrer-Policy, Permissions-Policy, Content-Security-Policy (strict, with an explicit script/connect domain allowlist)
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
   JWT_EXPIRY_HOURS=1
   JWT_REFRESH_EXPIRY_DAYS=30

   TMDB_API_KEY=<your-tmdb-api-key>
   TMDB_BASE_URL=https://api.themoviedb.org/3
   TMDB_IMAGE_BASE_URL=https://image.tmdb.org/t/p
   TMDB_TIMEOUT_SECONDS=10

   CORS_ALLOWED_ORIGINS=http://localhost:5173
   RATE_LIMIT_REQUESTS_PER_SECOND=10
   RATE_LIMIT_BURST_SIZE=50

   VITE_API_URL=http://localhost:8080

   # Cloudflare R2 object storage (optional — avatars, import archive,
   # poster cache, DB backups). Storage features are disabled if unset.
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

4. **Access the app**
   - Frontend: http://localhost:5173
   - Backend API: http://localhost:8080/api
   - Adminer (DB GUI): http://localhost:8081

### Production Deployment

```bash
# Create .env.prod with production values (use strong generated secrets!)
# Then build and deploy:
docker compose -f docker-compose.prod.yml --env-file .env.prod build backend frontend
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d
```

- Database migrations run automatically on backend startup. Because they are embedded at compile time, a new migration requires a backend rebuild.
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

### Testing

The project has **216 unit & integration tests** plus **12 Playwright E2E tests** across four layers:

```bash
# Backend unit tests (119 tests) — no external dependencies
cd backend && cargo test

# Frontend tests (53 tests) — Vitest + jsdom
cd frontend && npm test

# Backend integration tests (44 tests) — needs a test DB
docker compose -p cinetrack-test -f docker-compose.test.yml up -d --wait
cd backend && TEST_DATABASE_URL="postgres://test_user:test_pass@127.0.0.1:55433/cinetrack_test" \
  cargo test --test api_tests -- --ignored --test-threads=1
docker compose -p cinetrack-test -f docker-compose.test.yml down

# Frontend E2E — mocked backend, no DB needed (Playwright boots Vite itself)
cd frontend && npm run test:e2e

# Frontend E2E — real backend + ephemeral Postgres (Playwright boots both)
TEST_DB_PORT=55444 docker compose -f docker-compose.test.yml -p cinetrack_e2e up -d --wait
cd frontend && npm run test:e2e:realstack
docker compose -f docker-compose.test.yml -p cinetrack_e2e down -v

# Or run everything at once:
./scripts/run_tests.sh
```

**What's tested:**
- **Unit tests** — JWT generation/validation, Argon2id hashing, password policy, all DTO validators (boundary cases, XSS rejection), error mapping & sanitization
- **Integration tests** — Full auth flows (register, login, refresh rotation, logout), access control (all protected endpoints return 401), IDOR protection, user enumeration prevention, profile privacy (email hidden), follow/unfollow, list CRUD
- **Frontend tests** — Zustand stores (auth, theme), utility functions (class merging, URL builders, formatters), type contracts, error-boundary fallback
- **E2E tests (Playwright)** — route guards and login/logout/forgot-password against a mocked API, plus a real-stack suite (live backend + ephemeral Postgres) covering registration with an HttpOnly refresh cookie, real token rotation through the browser, active sessions, account deletion, and password reset via the emailed token

## Project Structure

```
văzute/
├── backend/                # Rust + Actix-Web API
│   ├── migrations/         # SQLx database migrations
│   ├── tests/
│   │   └── api_tests.rs    # Integration tests (44 tests, need test DB)
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
│       │   ├── import.rs   # TV Time import (multipart -> background job)
│       │   ├── assets.rs   # Avatars, R2 asset proxy, poster cache
│       │   └── ...
│       ├── services/       # Business logic
│       │   ├── tmdb.rs     # TMDB client + media/season/episode caching
│       │   ├── importer.rs # TV Time -> TMDB resolution + import pipeline
│       │   ├── storage.rs  # Cloudflare R2 (S3) wrapper
│       │   └── ...
│       └── utils/          # JWT, password, refresh token helpers
├── frontend/               # React + Vite + TypeScript
│   └── src/
│       ├── components/     # UI components (Navbar, etc.)
│       ├── hooks/          # TanStack Query hooks
│       ├── pages/          # Route pages
│       ├── store/          # Zustand stores (auth, theme)
│       ├── lib/            # API client with refresh interceptor
│       ├── test/           # Vitest tests (53 tests)
│       └── types/          # TypeScript interfaces
├── scripts/
│   ├── run_tests.sh        # All-in-one test runner
│   └── backup_to_r2.sh     # pg_dump -> gzip -> Cloudflare R2 (with retention)
├── nginx/                  # Internal reverse proxy config
├── docker-compose.yml      # Development stack
├── docker-compose.test.yml # Ephemeral test DB (tmpfs, port 55433 by default)
└── docker-compose.prod.yml # Production stack (with resource limits)
```

## API Overview

All endpoints except auth (register/login/refresh) require a valid JWT access token.

| Area | Endpoints |
|------|-----------|
| **Auth** | Register, Login, Logout, Refresh Token, Me |
| **Media** | Search, Details, Seasons/Episodes, Trending |
| **Tracking** | CRUD for user's movie/show list with status, rating, review |
| **History** | Log watched episodes/movies with timestamps |
| **Stats** | Heatmap data, watch time, streaks, genre distribution |
| **Users** | Public profiles, follow/unfollow, activity feed |
| **Lists** | Custom user-created lists (public/private) |
| **Import** | Start a TV Time import (`POST /import/tvtime`, multipart); poll job status |
| **Avatars** | Upload / remove profile picture (`POST`/`DELETE /users/me/avatar`) |
| **Assets** | Public proxy for R2 objects (`GET /assets/{key}`); TMDB poster cache (`GET /img/{size}/{path}`) |

## Importing from TV Time

Users migrating from TV Time can bring their history in from **Settings → Import from TV Time**.

- **Input** — the browser-extension export (`shows.json`, `movies.json`) and, optionally, the GDPR `rewatched_episode.csv`.
- **ID resolution** — TV Time keys shows by **TVDB** id and movies by **IMDB** id; the app is **TMDB**-based, so the importer resolves each via TMDB's `/find` endpoint with a title-search fallback.
- **Matching** — episodes link by `(season, episode)`; for shows whose numbering diverges from TMDB (e.g. anime, or shows TV Time numbers by year), it falls back to **absolute-position** matching. Watches that TMDB can't represent are still recorded by date (they count toward the heatmap) and reported as "date-only".
- **Execution** — runs as a background job (`import_jobs` table); the UI polls for status and shows a summary (shows / movies / episodes linked / date-only / unresolved). One import per account.
- If R2 is configured, the raw uploaded files are archived under `imports/{user}/{job}/` for audit/re-run.

## Object Storage & Backups (Cloudflare R2)

Object storage is **optional** — set the `R2_*` variables to enable it; without them the app runs normally and storage features are disabled. R2 is used for:

- **Avatars** — `avatars/{user_id}.{ext}`, served via the asset proxy (or a public domain if `R2_PUBLIC_BASE_URL` is set).
- **Import archive** — raw uploads under `imports/`.
- **Poster cache** — an opt-in write-through cache (`VITE_USE_R2_IMAGES=true`) that mirrors TMDB images under `posters/` and serves them from `GET /api/img/{size}/{path}`.
- **Database backups** — `scripts/backup_to_r2.sh` runs `pg_dump | gzip` and uploads a timestamped snapshot to `backups/`, pruning anything older than the retention window (default 14 days). Schedule it with cron:
  ```cron
  30 3 * * * /path/to/cineTrack/scripts/backup_to_r2.sh >> /var/log/vazute-backup.log 2>&1
  ```

## License

Released under the [MIT License](LICENSE).
