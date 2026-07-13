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

async function stubSession(page: Page, token = 'session-access-token', user = TEST_USER) {
  await page.unroute('**/api/auth/refresh');
  await page.route('**/api/auth/refresh', (route) =>
    route.fulfill({
      json: { access_token: token, token_type: 'Bearer', expires_in: 3600, user },
    })
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
      return route.fallback();
    }
    if (url.includes('/api/auth/me')) return route.fulfill({ json: TEST_USER });
    if (url.includes('/api/media/trending')) return route.fulfill({ json: { results: [] } });
    if (url.includes('/api/stats/me/heatmap')) return route.fulfill({ json: [] });
    if (url.includes('/api/stats/me')) return route.fulfill({ json: EMPTY_STATS });
    return route.fulfill({ json: [] });
  });
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/auth/refresh', (route) =>
    route.fulfill({ status: 401, json: { message: 'No active session' } })
  );
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
  await page.getByLabel('Email').fill('e2e@example.com');
  await page.getByLabel('Password').fill('WrongPass1');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByText('Invalid email or password')).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
});

test('blocks path-unsafe usernames before registration reaches the API', async ({ page }) => {
  let registrationRequests = 0;
  await page.route('**/api/auth/register', (route) => {
    registrationRequests += 1;
    return route.fulfill({ status: 500, json: { message: 'should not be called' } });
  });

  await page.goto('/register');
  const username = page.getByLabel('Username');
  await username.fill('bad user');
  await page.getByLabel('Email').fill('safe@example.com');
  await page.getByLabel('Password').fill('Password1');
  await page.getByRole('button', { name: 'Create account' }).click();

  expect(await username.evaluate((input) => input.checkValidity())).toBe(false);
  expect(registrationRequests).toBe(0);
  await expect(page).toHaveURL(/\/register$/);
});

test('logs in and lands on the dashboard', async ({ page }) => {
  await stubAuthedReads(page);
  await page.route('**/api/auth/login', (route) =>
    route.fulfill({
      json: { access_token: 'access-1', token_type: 'Bearer', expires_in: 3600, user: TEST_USER },
    })
  );

  await page.goto('/login');
  await page.getByLabel('Email').fill('e2e@example.com');
  await page.getByLabel('Password').fill('Password1');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page).toHaveURL('http://localhost:5173/');
  await expect(page.getByRole('button', { name: 'Logout' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('cinetrack-auth'))).toBeNull();
});

test('hydrates a session from the HttpOnly-cookie refresh flow after reload', async ({ page }) => {
  await stubSession(page);
  await stubAuthedReads(page);

  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Logout' })).toBeVisible();
  await page.reload();

  await expect(page).toHaveURL('http://localhost:5173/');
  await expect(page.getByRole('button', { name: 'Logout' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('cinetrack-auth'))).toBeNull();
});

test('shows followed episode activity on the dashboard', async ({ page }) => {
  await stubSession(page, 'session-access-token', {
    ...TEST_USER,
    username: 'dashboard_user_with_a_maximum_length_identifier_12',
  });
  await stubAuthedReads(page);
  await page.route('**/api/users/me/feed**', (route) =>
    route.fulfill({
      json: [
        {
          id: '00000000-0000-4000-8000-000000000010',
          user_id: '00000000-0000-4000-8000-000000000011',
          username: 'followed_user',
          avatar_url: null,
          action: 'watched',
          tmdb_id: 502,
          media_title: 'Followed Show',
          media_type: 'tv',
          poster_path: null,
          episode_name: 'The Reveal',
          season_number: 2,
          episode_number: 3,
          timestamp: '2026-07-12T12:00:00Z',
        },
      ],
    })
  );

  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Recent Activity' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'followed_user' })).toHaveAttribute(
    'href',
    '/profile/followed_user'
  );
  await expect(page.getByRole('link', { name: 'Open Followed Show' })).toHaveAttribute(
    'href',
    '/media/502?type=tv'
  );
  await expect(page.getByText('S2 E3 · The Reveal')).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
    )
  ).toBe(true);
});

test('discovers and follows people from search', async ({ page }) => {
  await stubSession(page);
  await stubAuthedReads(page);
  let followRequests = 0;
  await page.route('**/api/users/search**', (route) =>
    route.fulfill({
      json: {
        page: 1,
        has_more: false,
        results: [
          {
            id: '00000000-0000-4000-8000-000000000020',
            username: 'alpha_user',
            avatar_url: null,
            bio: 'Tracks science fiction shows',
            is_public: true,
            followers_count: 4,
            follow_status: null,
          },
        ],
      },
    })
  );
  await page.route('**/api/users/alpha_user/follow', (route) => {
    followRequests += 1;
    return route.fulfill({ json: { status: 'accepted' } });
  });

  await page.goto('/search');
  await page.getByRole('tab', { name: 'People' }).click();
  await page.getByLabel('Search people').fill('alpha');

  await expect(page.getByRole('link', { name: 'alpha_user', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Follow alpha_user' }).click();
  expect(followRequests).toBe(1);

  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
    )
  ).toBe(true);
});

test('logs out and returns to the login page', async ({ page }) => {
  await stubSession(page);
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
  let refreshAttempts = 0;
  let rejectProtectedRequests = false;
  await page.unroute('**/api/auth/refresh');
  await page.route('**/api/auth/refresh', (route) => {
    refreshAttempts += 1;
    if (refreshAttempts === 1) {
      return route.fulfill({
        json: {
          access_token: 'expired-token',
          token_type: 'Bearer',
          expires_in: 3600,
          user: TEST_USER,
        },
      });
    }
    return route.fulfill({ status: 401, json: { message: 'Invalid refresh token' } });
  });

  await stubAuthedReads(page);
  await page.route('**/api/**', (route) => {
    if (route.request().url().includes('/api/auth/refresh')) {
      return route.fallback();
    }
    if (!rejectProtectedRequests) {
      return route.fallback();
    }
    return route.fulfill({ status: 401, json: { message: 'Unauthorized' } });
  });

  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Logout' })).toBeVisible();

  // Expire the access token only after cookie hydration has completed, then
  // trigger a fresh protected query from a real navigation.
  rejectProtectedRequests = true;
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect(refreshAttempts).toBe(2);
});

test('contains a page crash in a fallback and keeps the navbar', async ({ page }) => {
  await stubSession(page);
  // A malformed trending payload (missing `results`) makes the Dashboard throw
  // during render. The error boundary must show the fallback instead of letting
  // the whole SPA unmount to a white screen, and the navbar must survive.
  await page.route('**/api/**', (route) => {
    const url = route.request().url();
    if (url.includes('/api/auth/refresh')) return route.fallback();
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
  await page.getByLabel('Email').fill('whoever@example.com');
  await page.getByRole('button', { name: 'Send reset link' }).click();

  await expect(page.getByText(/reset link is on its way/i)).toBeVisible();
});
