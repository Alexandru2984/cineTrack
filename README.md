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
- **TMDB API v3** — Movie/TV show metadata

### Frontend
- **React 19** + **TypeScript** — UI framework
- **Vite 8** — Build tool
- **Tailwind CSS 4** — Styling
- **TanStack Query 5** — Server state management
- **Zustand 5** — Client state management
- **Recharts** — Statistics charts
- **react-calendar-heatmap** — Activity visualization

### Infrastructure
- **Docker** + **Docker Compose** — Containerization with resource limits
- **Nginx** — Reverse proxy with SSL termination (Let's Encrypt)
- Non-root containers (backend + frontend)

## Security

The application has been through multiple security audits. Key measures include:

- **Authentication** — Short-lived JWT access tokens (1h) with SHA-256 hashed refresh tokens, automatic rotation, and per-user token cap (max 5 sessions)
- **Rate Limiting** — Global rate limiter (10 req/s, burst 50) + stricter auth-specific limiter (3 req/s, burst 10) to prevent brute-force
- **Password Policy** — Minimum 8 characters, must contain at least one letter and one digit, rejects all-same-character passwords
- **Input Validation** — All user inputs validated with length limits (bio 500, review 5000, list names 200, etc.) and content validation
- **Privacy** — Private profiles hide activity/followers from non-followers; public user endpoints never expose emails; no user enumeration on register
- **Access Control** — Private lists return 404 to non-owners; all media endpoints require authentication; history entries validated against existing media
- **Security Headers** — HSTS, X-Frame-Options (DENY), X-Content-Type-Options, Referrer-Policy, Permissions-Policy, Content-Security-Policy (strict, with script hash whitelist)
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

   CORS_ALLOWED_ORIGINS=http://localhost:5173
   RATE_LIMIT_REQUESTS_PER_SECOND=10
   RATE_LIMIT_BURST_SIZE=50

   VITE_API_URL=http://localhost:8080
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
docker compose -f docker-compose.prod.yml --env-file .env.prod build --no-cache
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d
```

Production containers run behind a host-level Nginx reverse proxy with SSL termination.

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

## Project Structure

```
văzute/
├── backend/                # Rust + Actix-Web API
│   ├── migrations/         # SQLx database migrations
│   └── src/
│       ├── config.rs       # Environment configuration
│       ├── db.rs           # Database pool setup
│       ├── errors.rs       # Error types & sanitization
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
│       ├── services/       # Business logic (TMDB, auth)
│       └── utils/          # JWT, password, refresh token helpers
├── frontend/               # React + Vite + TypeScript
│   └── src/
│       ├── components/     # UI components (Navbar, etc.)
│       ├── hooks/          # TanStack Query hooks
│       ├── pages/          # Route pages
│       ├── store/          # Zustand stores (auth, theme)
│       ├── lib/            # API client with refresh interceptor
│       └── types/          # TypeScript interfaces
├── nginx/                  # Internal reverse proxy config
├── docker-compose.yml      # Development stack
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

## License

This project is for personal/educational use.
