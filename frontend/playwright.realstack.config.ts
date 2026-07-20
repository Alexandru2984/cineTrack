import { defineConfig, devices } from '@playwright/test';

/**
 * Real-stack E2E: drives the browser against an actually-running backend and
 * Postgres (no network mocking), so it covers what the mocked suite and the
 * Rust integration tests can't together — the HttpOnly refresh cookie, real
 * token rotation through the browser, and the reset-token flow end to end.
 *
 * Postgres must already be reachable at E2E_DATABASE_URL (the CI job provides a
 * `postgres` service; locally use docker-compose.test.yml). Playwright then
 * boots the backend and the Vite dev server itself.
 */
function configuredPort(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    throw new Error(`${name} must be an integer between 1024 and 65535`);
  }
  return value;
}

const BACKEND_PORT = configuredPort('E2E_BACKEND_PORT', 8099);
const FRONTEND_PORT = configuredPort('E2E_FRONTEND_PORT', 5173);
const API_URL = `http://localhost:${BACKEND_PORT}`;
export const FRONTEND_ORIGIN = `http://localhost:${FRONTEND_PORT}`;
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  'postgres://test_user:test_pass@127.0.0.1:55444/cinetrack_test';

// Backend stdout is tee'd here so the reset-password spec can read the
// log-only reset URL (SMTP is unset, so the token is logged, not emailed).
export const BACKEND_LOG = 'playwright-backend.log';

export default defineConfig({
  testDir: './e2e-realstack',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${FRONTEND_PORT}`,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: `sh -c 'cargo run --manifest-path ../backend/Cargo.toml 2>&1 | tee ${BACKEND_LOG}'`,
      url: `http://localhost:${BACKEND_PORT}/api/health`,
      timeout: 300_000,
      // Reusing an arbitrary local process can silently point the browser at
      // another API, including a developer's production-configured backend.
      reuseExistingServer: false,
      env: {
        APP_ENV: 'development',
        APP_HOST: '127.0.0.1',
        APP_PORT: String(BACKEND_PORT),
        DATABASE_URL,
        JWT_SECRET: 'e2e-realstack-jwt-secret-at-least-32-bytes-long-padding-padding',
        JWT_EXPIRY_MINUTES: '15',
        JWT_REFRESH_EXPIRY_DAYS: '30',
        TMDB_API_KEY: 'dummy-tmdb-key-not-used-by-auth-flows',
        TMDB_READ_ACCESS_TOKEN: '',
        FRONTEND_URL: FRONTEND_ORIGIN,
        CORS_ALLOWED_ORIGINS: FRONTEND_ORIGIN,
        SMTP_HOST: '',
        SMTP_USERNAME: '',
        SMTP_PASSWORD: '',
        R2_S3_API: '',
        R2_ENDPOINT: '',
        R2_ACCESS_KEY_ID: '',
        R2_SECRET_ACCESS_KEY: '',
        R2_BUCKET: '',
        R2_PUBLIC_BASE_URL: '',
        // Don't let the global limiter throttle a fast test run.
        RATE_LIMIT_REQUESTS_PER_SECOND: '100',
        RATE_LIMIT_BURST_SIZE: '1000',
        // INFO so the log-only reset URL line is emitted for the reset spec.
        RUST_LOG: 'info',
      },
    },
    {
      command: `npm run dev -- --host 127.0.0.1 --port ${FRONTEND_PORT} --strictPort`,
      url: `http://localhost:${FRONTEND_PORT}`,
      timeout: 120_000,
      reuseExistingServer: false,
      // Point the SPA at the test backend (Vite exposes VITE_-prefixed process
      // env to import.meta.env), since the default assumes port 8080.
      env: { VITE_API_URL: API_URL },
    },
  ],
});
