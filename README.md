# 🎬 CineTrack

A personal movie and TV show tracker with social features, inspired by TV Time. Track what you watch, visualize your activity with a GitHub-style heatmap, and keep detailed stats on your viewing habits.

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
- **Social Features** — Follow other users, public profiles, custom lists

## Tech Stack

### Backend
- **Rust** + **Actix-Web 4** — High-performance async web framework
- **SQLx** — Async PostgreSQL driver with compile-time checked queries
- **PostgreSQL 16** — Primary database
- **JWT** — Authentication with access + refresh token rotation
- **Argon2id** — Password hashing
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
- **Docker** + **Docker Compose** — Containerization
- **Nginx** — Reverse proxy with SSL termination

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

2. **Create `.env` from the example**
   ```bash
   cp .env.example .env
   ```

3. **Fill in your secrets** in `.env`:
   - `POSTGRES_PASSWORD` — generate a random password
   - `JWT_SECRET` — generate with `openssl rand -base64 64`
   - `TMDB_API_KEY` — from your TMDB account
   - OAuth credentials (optional) — Google and/or GitHub

4. **Start the development stack**
   ```bash
   docker compose up -d
   ```

5. **Access the app**
   - Frontend: http://localhost:5173
   - Backend API: http://localhost:8080/api
   - Adminer (DB GUI): http://localhost:8081

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
cinetrack/
├── backend/             # Rust + Actix-Web API
│   ├── migrations/      # SQLx database migrations
│   └── src/
│       ├── config.rs    # Environment configuration
│       ├── db.rs        # Database pool setup
│       ├── errors.rs    # Error types
│       ├── main.rs      # Entry point
│       ├── dto/         # Request/Response types
│       ├── middleware/   # JWT auth middleware
│       ├── models/      # Database models
│       ├── routes/      # API route handlers
│       ├── services/    # Business logic (TMDB, auth)
│       └── utils/       # JWT, password helpers
├── frontend/            # React + Vite + TypeScript
│   └── src/
│       ├── components/  # UI components
│       ├── hooks/       # TanStack Query hooks
│       ├── pages/       # Route pages
│       ├── store/       # Zustand stores
│       ├── lib/         # API client, utilities
│       └── types/       # TypeScript types
├── nginx/               # Reverse proxy config
├── docker-compose.yml   # Development stack
└── docker-compose.prod.yml
```

## API Overview

| Area | Endpoints |
|------|-----------|
| **Auth** | Register, Login, Logout, Refresh, OAuth (Google/GitHub), Me |
| **Media** | Search, Details, Seasons/Episodes, Trending |
| **Tracking** | CRUD for user's movie/show list with status, rating, review |
| **History** | Log watched episodes/movies with timestamps |
| **Stats** | Heatmap data, watch time, streaks, genre distribution |
| **Users** | Public profiles, follow/unfollow, activity feed |
| **Lists** | Custom user-created lists |

## License

This project is for personal/educational use.
