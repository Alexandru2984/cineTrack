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

const EMPTY_DISCOVERY = {
  recommendations: [],
  personalized: false,
  recommendation_basis: [],
  popular_movies: [],
  popular_shows: [],
};

/**
 * Make every authenticated read succeed with a correctly *shaped* payload so
 * protected pages (Dashboard) render with the response contracts they expect.
 */
async function stubAuthedReads(page: Page, discovery = EMPTY_DISCOVERY) {
  await page.route('**/api/**', (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() !== 'GET') {
      return route.fallback();
    }
    if (url.includes('/api/auth/me')) return route.fulfill({ json: TEST_USER });
    if (url.includes('/api/notifications')) {
      return route.fulfill({ json: { items: [], unread_count: 0, has_more: false } });
    }
    if (url.includes('/api/calendar/up-next')) return route.fulfill({ json: { items: [] } });
    if (url.includes('/api/media/discovery')) return route.fulfill({ json: discovery });
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
  await expect(page).toHaveURL(/\/login\?returnTo=%2F$/);
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
});

test('publishes privacy controls and returns to account deletion after login', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/privacy');
  await expect(page.getByRole('heading', { name: 'Privacy policy' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'account deletion page' })).toBeVisible();

  await page.goto('/account-deletion');
  await page.getByRole('link', { name: 'Continue to account deletion' }).click();
  await expect(page).toHaveURL(/\/login\?returnTo=%2Fsettings%23delete-account$/);

  await stubAuthedReads(page);
  await page.route('**/api/auth/login', (route) =>
    route.fulfill({
      json: { access_token: 'access-1', token_type: 'Bearer', expires_in: 3600, user: TEST_USER },
    })
  );
  await page.getByLabel('Email').fill('e2e@example.com');
  await page.getByLabel('Password').fill('Password1');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page).toHaveURL(/\/settings#delete-account$/);
  await expect(page.getByRole('heading', { name: 'Delete account' })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
    )
  ).toBe(true);
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

test('manages the next sequential episode from mobile home', async ({ page }) => {
  await stubSession(page);
  await stubAuthedReads(page);
  let watchedRequests = 0;
  let upNextItems = [
    {
      episode_id: '00000000-0000-4000-8000-000000000020',
      media_id: '00000000-0000-4000-8000-000000000021',
      tmdb_id: 502,
      title: 'Mobile Queue Show',
      poster_path: null,
      season_number: 1,
      episode_number: 3,
      episode_name: 'Queue Episode',
      overview: null,
      runtime_minutes: 44,
      air_date: '2026-07-16',
      still_path: null,
      is_planned: false,
    },
  ];
  await page.route('**/api/calendar/up-next**', (route) =>
    route.fulfill({ json: { items: upNextItems } })
  );
  await page.route('**/api/calendar/episodes/*/watched', (route) => {
    watchedRequests += 1;
    upNextItems = [];
    return route.fulfill({
      json: {
        history_id: '00000000-0000-4000-8000-000000000022',
        media_id: '00000000-0000-4000-8000-000000000021',
        episode_id: '00000000-0000-4000-8000-000000000020',
        already_watched: false,
      },
    });
  });

  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Up Next' })).toBeVisible();
  await expect(page.getByText('Mobile Queue Show')).toBeVisible();

  await page.getByRole('button', { name: 'Mark Queue Episode watched' }).click();

  await expect.poll(() => watchedRequests).toBe(1);
  await expect(page.getByText("You're caught up")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
    )
  ).toBe(true);
});

test('confirms and marks an episode together with previous gaps', async ({ page }) => {
  await stubSession(page);
  let watchedThroughRequests = 0;

  await page.route('**/api/**', (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/auth/refresh') {
      return route.fulfill({
        json: {
          access_token: 'session-access-token',
          token_type: 'Bearer',
          expires_in: 3600,
          user: TEST_USER,
        },
      });
    }
    if (request.method() === 'POST' && path.endsWith('/watched-through')) {
      watchedThroughRequests += 1;
      return route.fulfill({
        json: {
          media_id: '00000000-0000-4000-8000-000000000100',
          candidate_count: 2,
          marked_count: 2,
          already_watched_count: 0,
        },
      });
    }
    if (path === '/api/notifications') {
      return route.fulfill({ json: { items: [], unread_count: 0, has_more: false } });
    }
    if (path === '/api/calendar/summary') {
      return route.fulfill({
        json: { new_count: 0, planned_count: 0, last_synced_at: null },
      });
    }
    if (path === '/api/media/1399') {
      return route.fulfill({
        json: {
          id: '1399',
          tmdb_id: 1399,
          media_type: 'tv',
          title: 'Bulk Watch Show',
          original_title: null,
          overview: null,
          poster_path: null,
          backdrop_path: null,
          release_date: '2020-01-01',
          status: 'Returning Series',
          genres: [],
          runtime_minutes: 45,
          vote_average: 8,
        },
      });
    }
    if (path === '/api/media/1399/seasons') {
      return route.fulfill({
        json: [
          {
            id: 'season-one',
            season_number: 1,
            name: 'Season 1',
            episode_count: 2,
            air_date: '2020-01-01',
          },
        ],
      });
    }
    if (path === '/api/media/1399/seasons/1/episodes') {
      return route.fulfill({
        json: [
          {
            id: 'episode-one',
            episode_number: 1,
            name: 'First',
            overview: null,
            runtime_minutes: 45,
            air_date: '2020-01-01',
            still_path: null,
          },
          {
            id: 'episode-two',
            episode_number: 2,
            name: 'Second',
            overview: null,
            runtime_minutes: 45,
            air_date: '2020-01-08',
            still_path: null,
          },
        ],
      });
    }
    if (path === '/api/history/tv/1399/seasons/1/episodes') {
      return route.fulfill({ json: [] });
    }
    if (path === '/api/history/tv/1399/progress') {
      return route.fulfill({
        json: [
          {
            season_number: 1,
            episode_count: 2,
            available_episode_count: 2,
            watched_count: 0,
          },
        ],
      });
    }
    return route.fulfill({ json: [] });
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/media/1399?type=tv');
  await page.getByTitle('Mark watched').last().click();
  const dialog = page.getByRole('dialog', { name: 'Mark S01E02 watched?' });
  await expect(dialog).toBeVisible();
  expect(
    await dialog.evaluate((element) => getComputedStyle(element.parentElement!).zIndex)
  ).toBe('80');
  expect(
    await page
      .getByRole('navigation', { name: 'Primary mobile navigation' })
      .evaluate((element) => getComputedStyle(element).zIndex)
  ).toBe('40');
  await page.getByRole('button', { name: 'This and previous' }).click();

  await expect.poll(() => watchedThroughRequests).toBe(1);
});

test('renders local discovery shelves without viewport overflow', async ({ page }) => {
  await stubSession(page);
  const recommendations = Array.from({ length: 12 }, (_, index) => ({
    id: 700000 + index,
    media_type: index % 3 === 0 ? 'tv' : 'movie',
    title: index % 3 === 0 ? undefined : `Localized recommendation title ${index + 1}`,
    name: index % 3 === 0 ? `Localized series title ${index + 1}` : undefined,
    poster_path: null,
    vote_average: 8.1,
  }));
  await stubAuthedReads(page, {
    recommendations,
    personalized: true,
    recommendation_basis: ['Drama', 'Thriller'],
    popular_movies: recommendations.filter((item) => item.media_type === 'movie'),
    popular_shows: recommendations.filter((item) => item.media_type === 'tv'),
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'For You' })).toBeVisible();
  await expect(page.getByText('Drama · Thriller')).toBeVisible();
  const shelf = page.getByRole('list', { name: 'For You titles' });
  await expect(shelf).toBeVisible();
  expect(await shelf.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: 'Popular Movies' })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
    )
  ).toBe(true);
});

test('uses a touch-safe primary tab bar on narrow authenticated screens', async ({ page }) => {
  await stubSession(page);
  await stubAuthedReads(page);
  await page.route('**/api/calendar/summary**', (route) =>
    route.fulfill({
      json: {
        new_count: 3,
        planned_count: 0,
        last_synced_at: '2026-07-16T12:00:00Z',
      },
    })
  );

  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto('/');

  const navigation = page.getByRole('navigation', {
    name: 'Primary mobile navigation',
  });
  await expect(navigation).toBeVisible();
  await expect(navigation.getByRole('link', { name: 'Home' })).toHaveAttribute(
    'aria-current',
    'page'
  );
  await expect(
    navigation.getByRole('link', { name: 'Calendar, 3 new episodes' })
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open navigation' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Settings' })).toBeVisible();

  const navBox = await navigation.boundingBox();
  const mainPaddingBottom = await page.locator('main').evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).paddingBottom)
  );
  expect(navBox).not.toBeNull();
  expect(mainPaddingBottom).toBeGreaterThanOrEqual(navBox!.height);

  await navigation.getByRole('link', { name: 'Library' }).click();
  await expect(page).toHaveURL(/\/tracking$/);
  await expect(navigation.getByRole('link', { name: 'Library' })).toHaveAttribute(
    'aria-current',
    'page'
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
    )
  ).toBe(true);
});

test('edits library feedback on a narrow screen', async ({ page }) => {
  await stubSession(page);
  await stubAuthedReads(page);
  const trackedTitle = {
    id: '00000000-0000-4000-8000-000000000030',
    media_id: '00000000-0000-4000-8000-000000000031',
    tmdb_id: 42,
    media_type: 'movie',
    title: 'A Library Title With A Long Name',
    poster_path: null,
    status: 'completed',
    rating: 7,
    review: 'Original review',
    is_favorite: false,
    started_at: null,
    completed_at: null,
  };
  let trackingListUrl = '';
  await page.route('**/api/tracking**', (route) => {
    trackingListUrl = route.request().url();
    return route.fulfill({ json: [trackedTitle] });
  });
  let updatePayload: unknown;
  await page.route(`**/api/tracking/${trackedTitle.id}`, async (route) => {
    updatePayload = route.request().postDataJSON();
    return route.fulfill({ json: { ...trackedTitle, ...(updatePayload as object) } });
  });

  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto('/tracking');
  await expect.poll(() => trackingListUrl).toContain('limit=100');
  expect(new URL(trackingListUrl).searchParams.get('page')).toBe('1');
  await page.getByRole('button', {
    name: `Edit rating and review for ${trackedTitle.title}`,
  }).click();

  const dialog = page.getByRole('dialog', { name: 'Your rating and review' });
  await expect(dialog).toBeVisible();
  await page.getByRole('button', { name: 'Increase rating' }).click();
  await dialog.getByRole('textbox', { name: 'Review' }).fill('  Better on a second viewing.  ');
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
    )
  ).toBe(true);
  const dialogBox = await dialog.boundingBox();
  expect(dialogBox).not.toBeNull();
  expect(dialogBox!.width).toBeLessThanOrEqual(320);

  await page.getByRole('button', { name: 'Save' }).click();
  await expect.poll(() => updatePayload).toEqual({
    rating: 8,
    review: 'Better on a second viewing.',
  });
  await expect(dialog).toHaveCount(0);
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
  await expect.poll(() => followRequests).toBe(1);

  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
    )
  ).toBe(true);
});

test('shows unread social notifications and marks the inbox as read', async ({ page }) => {
  await stubSession(page);
  await stubAuthedReads(page);
  let unread = true;
  let markAllRequests = 0;

  await page.route('**/api/notifications**', (route) => {
    if (route.request().method() === 'POST') {
      markAllRequests += 1;
      unread = false;
      return route.fulfill({ json: { message: 'Notifications marked as read', updated: 1 } });
    }
    return route.fulfill({
      json: {
        items: [
          {
            id: '00000000-0000-4000-8000-000000000030',
            kind: 'follow_request',
            actor_id: '00000000-0000-4000-8000-000000000031',
            actor_username: 'private_requester',
            actor_avatar_url: null,
            read_at: unread ? null : '2026-07-13T12:05:00Z',
            created_at: '2026-07-13T12:00:00Z',
          },
        ],
        unread_count: unread ? 1 : 0,
        has_more: false,
      },
    });
  });

  await page.goto('/');
  const bell = page.getByRole('button', { name: 'Notifications, 1 unread notification' });
  await expect(bell).toBeVisible();
  await bell.click();
  await expect(page.getByText('requested to follow you')).toBeVisible();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Escape');
  await expect(bell).toBeFocused();
  await bell.click();
  await page.getByRole('link', { name: 'View all notifications' }).click();

  await expect(page).toHaveURL(/\/notifications$/);
  await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();
  await expect(page.getByText('1 unread notification')).toBeVisible();
  await page.getByRole('button', { name: 'Mark all as read' }).click();
  await expect(page.getByText('You are all caught up.')).toBeVisible();
  expect(markAllRequests).toBe(1);

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
  await expect(page).toHaveURL(/\/login\?returnTo=%2Fsettings$/);
  expect(refreshAttempts).toBe(2);
});

test('contains a page crash in a fallback and keeps the navbar', async ({ page }) => {
  await stubSession(page);
  // A malformed discovery list makes the Dashboard throw
  // during render. The error boundary must show the fallback instead of letting
  // the whole SPA unmount to a white screen, and the navbar must survive.
  await page.route('**/api/**', (route) => {
    const url = route.request().url();
    if (url.includes('/api/auth/refresh')) return route.fallback();
    if (url.includes('/api/auth/me')) return route.fulfill({ json: TEST_USER });
    if (url.includes('/api/notifications')) {
      return route.fulfill({ json: { items: [], unread_count: 0, has_more: false } });
    }
    if (url.includes('/api/stats/me/heatmap')) return route.fulfill({ json: [] });
    if (url.includes('/api/stats/me')) return route.fulfill({ json: EMPTY_STATS });
    if (url.includes('/api/media/discovery')) {
      return route.fulfill({ json: { ...EMPTY_DISCOVERY, recommendations: 'invalid' } });
    }
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
