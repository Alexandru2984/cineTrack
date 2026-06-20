import { test, expect, type Page } from '@playwright/test';

/**
 * Auth flow E2E. The backend is mocked at the network layer, so these specs
 * exercise the real browser behaviour the Rust integration tests can't:
 * route guards, the persisted auth store, the axios refresh-on-401 interceptor,
 * and post-action redirects.
 */

const TEST_USER = {
  id: '00000000-0000-0000-0000-000000000001',
  username: 'e2euser',
  email: 'e2e@example.com',
  avatar_url: null,
  bio: null,
  is_public: true,
  created_at: '2026-01-01T00:00:00Z',
};

/** Pre-seed the persisted Zustand auth store so the app boots authenticated. */
async function seedAuth(page: Page, token = 'seed-access-token') {
  await page.addInitScript(
    (arg) => {
      localStorage.setItem(
        'cinetrack-auth',
        JSON.stringify({ state: { token: arg.token, user: arg.user }, version: 0 })
      );
    },
    { token, user: TEST_USER }
  );
}

const EMPTY_STATS = {
  total_movies: 0,
  total_shows: 0,
  total_episodes: 0,
  total_hours: 0,
  current_streak: 0,
  longest_streak: 0,
};

/**
 * Make every authenticated read succeed with a correctly *shaped* payload so
 * protected pages (Dashboard) render without crashing — the app has no error
 * boundary, so a malformed response would unmount the whole tree.
 */
async function stubAuthedReads(page: Page) {
  await page.route('**/api/**', (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() !== 'GET') {
      return route.fulfill({ json: { message: 'ok' } });
    }
    if (url.includes('/api/auth/me')) return route.fulfill({ json: TEST_USER });
    if (url.includes('/api/media/trending')) return route.fulfill({ json: { results: [] } });
    if (url.includes('/api/stats/me/heatmap')) return route.fulfill({ json: [] });
    if (url.includes('/api/stats/me')) return route.fulfill({ json: EMPTY_STATS });
    return route.fulfill({ json: [] });
  });
}

test.beforeEach(async ({ page }) => {
  // Keep tests offline and deterministic — never hit the real analytics host.
  await page.route('https://analytics.micutu.com/**', (route) => route.abort());
});

test('redirects unauthenticated users to the login page', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
});

test('shows an error message on invalid credentials', async ({ page }) => {
  await page.route('**/api/auth/login', (route) =>
    route.fulfill({
      status: 401,
      json: { error: '401 Unauthorized', message: 'Invalid email or password' },
    })
  );

  await page.goto('/login');
  await page.locator('input[type="email"]').fill('e2e@example.com');
  await page.locator('input[type="password"]').fill('WrongPass1');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByText('Invalid email or password')).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
});

test('logs in and lands on the dashboard', async ({ page }) => {
  await stubAuthedReads(page);
  await page.route('**/api/auth/login', (route) =>
    route.fulfill({
      json: { access_token: 'access-1', token_type: 'Bearer', expires_in: 3600, user: TEST_USER },
    })
  );

  await page.goto('/login');
  await page.locator('input[type="email"]').fill('e2e@example.com');
  await page.locator('input[type="password"]').fill('Password1');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page).toHaveURL('http://localhost:5173/');
  await expect(page.getByRole('button', { name: 'Logout' })).toBeVisible();
});

test('logs out and returns to the login page', async ({ page }) => {
  await seedAuth(page);
  await stubAuthedReads(page);
  await page.route('**/api/auth/logout', (route) =>
    route.fulfill({ json: { message: 'Logged out successfully' } })
  );

  await page.goto('/');
  const logout = page.getByRole('button', { name: 'Logout' });
  await expect(logout).toBeVisible();
  await logout.click();

  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
});

test('logs the user out when the token refresh fails', async ({ page }) => {
  await seedAuth(page, 'expired-token');
  // Every protected read 401s and the refresh attempt also fails, so the axios
  // interceptor must clear auth and redirect to /login.
  await page.route('**/api/**', (route) =>
    route.fulfill({ status: 401, json: { message: 'Unauthorized' } })
  );
  await page.route('**/api/auth/refresh', (route) =>
    route.fulfill({ status: 401, json: { message: 'Invalid refresh token' } })
  );

  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
});

test('contains a page crash in a fallback and keeps the navbar', async ({ page }) => {
  await seedAuth(page);
  // A malformed trending payload (missing `results`) makes the Dashboard throw
  // during render. The error boundary must show the fallback instead of letting
  // the whole SPA unmount to a white screen, and the navbar must survive.
  await page.route('**/api/**', (route) => {
    const url = route.request().url();
    if (url.includes('/api/auth/me')) return route.fulfill({ json: TEST_USER });
    if (url.includes('/api/media/trending')) return route.fulfill({ json: {} });
    return route.fulfill({ json: [] });
  });

  await page.goto('/');
  await expect(page.getByText('Something went wrong')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Logout' })).toBeVisible();
});

test('forgot password shows a uniform confirmation', async ({ page }) => {
  await page.route('**/api/auth/password/forgot', (route) =>
    route.fulfill({ json: { message: 'If that email is registered, a reset link has been sent' } })
  );

  await page.goto('/forgot-password');
  await page.locator('input[type="email"]').fill('whoever@example.com');
  await page.getByRole('button', { name: 'Send reset link' }).click();

  await expect(page.getByText(/reset link is on its way/i)).toBeVisible();
});
