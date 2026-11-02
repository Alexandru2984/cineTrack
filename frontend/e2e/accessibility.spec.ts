import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const USER = {
  id: '00000000-0000-4000-8000-000000000001',
  username: 'accessibility-user',
  email: 'accessibility@mailbox.dev',
  avatar_url: null,
  bio: null,
  is_public: true,
  email_verified: true,
  two_factor_enabled: true,
  terms_accepted_version: '2026-07-29',
  current_terms_version: '2026-07-29',
  terms_acceptance_required: false,
  created_at: '2026-01-01T00:00:00Z',
};

async function expectNoAccessibilityViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const violations = results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    help: violation.help,
    targets: violation.nodes.map((node) => node.target),
  }));
  expect(violations).toEqual([]);
}

async function stubAuthenticatedApp(page: Page) {
  await page.unroute('**/api/auth/refresh');
  await page.route('**/api/**', (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && path === '/api/auth/refresh') {
      return route.fulfill({
        json: {
          access_token: 'accessibility-token',
          token_type: 'Bearer',
          expires_in: 3600,
          user: USER,
        },
      });
    }
    if (request.method() === 'POST' && path === '/api/tracking/lookup') {
      return route.fulfill({ json: [] });
    }
    if (request.method() !== 'GET') return route.fulfill({ json: {} });
    if (path === '/api/auth/me') return route.fulfill({ json: USER });
    if (path === '/api/notifications') {
      return route.fulfill({ json: { items: [], unread_count: 0, has_more: false } });
    }
    if (path === '/api/calendar/summary') {
      return route.fulfill({
        json: { new_count: 0, planned_count: 0, last_synced_at: null },
      });
    }
    if (path === '/api/calendar/up-next') return route.fulfill({ json: { items: [] } });
    // A media detail payload with the fields the page actually renders. Without
    // it the generic `{}` fallback leaves the poster with no title, React drops
    // the `alt` attribute entirely, and the sweep reports a critical violation
    // that only its own stub creates.
    if (/^\/api\/media\/\d+$/.test(path)) {
      return route.fulfill({
        json: {
          id: 550,
          tmdb_id: 550,
          media_type: 'movie',
          title: 'Accessibility Fixture',
          original_title: 'Accessibility Fixture',
          overview: 'A fixture used to render the media detail page.',
          poster_path: null,
          backdrop_path: null,
          release_date: '2026-01-01',
          vote_average: 7.5,
          genres: [],
          runtime_minutes: 100,
          seasons: [],
        },
      });
    }
    if (path === '/api/media/discovery') {
      return route.fulfill({
        json: {
          recommendations: [],
          personalized: false,
          recommendation_basis: [],
          popular_movies: [],
          popular_shows: [],
        },
      });
    }
    if (path === '/api/stats/me') {
      return route.fulfill({
        json: {
          total_movies: 0,
          total_shows: 0,
          total_episodes: 0,
          total_hours: 0,
          current_streak: 0,
          longest_streak: 0,
        },
      });
    }
    if (path === '/api/moderation/me') {
      return route.fulfill({ json: { is_moderator: true } });
    }
    if (path === '/api/moderation/reports') {
      return route.fulfill({
        json: {
          items: [],
          counts: { open: 0, reviewing: 0, actioned: 0, dismissed: 0 },
          page: 1,
          has_more: false,
        },
      });
    }
    // The signed-in member's own profile. Without it the `[]` fallback left
    // the page with an empty heading, and the sweep audited a profile with no
    // name on it.
    if (path === `/api/users/${USER.username}`) {
      return route.fulfill({
        json: {
          id: USER.id,
          username: USER.username,
          avatar_url: null,
          bio: null,
          is_public: true,
          created_at: USER.created_at,
          followers_count: 0,
          following_count: 0,
          is_following: false,
          is_followed_by: false,
          follow_status: null,
          can_view_activity: true,
        },
      });
    }
    // A page of new episodes, not the `[]` fallback: reading `items` from that
    // threw inside the calendar, and the sweep audited the error screen.
    if (path === '/api/calendar/new') {
      return route.fulfill({ json: { items: [], next_cursor: null } });
    }
    // The rest of the payloads a page reads fields from. Each one, left to the
    // fallback, threw on its first field and put the error screen in its place.
    if (path === '/api/badges') {
      return route.fulfill({ json: { earned: [], progress: [] } });
    }
    if (path === '/api/stats/me/wrapped') {
      return route.fulfill({
        json: {
          year: 2026,
          total_watches: 0,
          movies_watched: 0,
          episodes_watched: 0,
          distinct_titles: 0,
          total_hours: 0,
          longest_streak: 0,
          first_watch: null,
          last_watch: null,
          top_genres: [],
          top_shows: [],
          monthly: [],
        },
      });
    }
    if (path === '/api/media/episodes/1') {
      return route.fulfill({
        json: {
          episode_id: '1',
          media_id: '00000000-0000-4000-8000-000000000003',
          tmdb_id: 1399,
          title: 'Accessibility Series',
          poster_path: null,
          backdrop_path: null,
          season_id: '00000000-0000-4000-8000-000000000004',
          season_number: 1,
          season_name: 'Season 1',
          episode_number: 1,
          episode_name: 'Pilot',
          overview: 'A fixture used to render the episode page.',
          runtime_minutes: 50,
          air_date: '2026-01-01',
          still_path: null,
          tracking_status: 'watching',
          is_available: true,
          is_watched: false,
          is_planned: false,
          watch_count: 0,
          last_watched_at: null,
          reactions: [],
          my_reaction: null,
        },
      });
    }
    if (path === '/api/users/reported-user') {
      return route.fulfill({
        json: {
          id: '00000000-0000-4000-8000-000000000002',
          username: 'reported-user',
          avatar_url: null,
          bio: 'Profile used for accessibility verification.',
          is_public: true,
          created_at: '2026-01-02T00:00:00Z',
          followers_count: 0,
          following_count: 0,
          follow_status: null,
          can_view_activity: true,
        },
      });
    }
    if (path === '/api/calendar/preferences') {
      return route.fulfill({
        json: { region: 'RO', include_movies: true, include_shows: true },
      });
    }
    if (path === '/api/calendar/feed') {
      return route.fulfill({ json: { enabled: false, created_at: null } });
    }
    return route.fulfill({ json: [] });
  });
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/auth/refresh', (route) =>
    route.fulfill({ status: 401, json: { message: 'No active session' } }),
  );
});

// Every route the router serves, not a sample. Six of the twenty-five were
// covered before, so a violation on any of the other nineteen — a link at
// 2.13:1 on the about page, as it turned out — could sit there unseen.
const PUBLIC_ROUTES = [
  '/login',
  '/register',
  '/privacy',
  '/terms',
  '/about',
  '/community-guidelines',
  '/forgot-password',
  '/reset-password',
  '/verify-email',
  '/confirm-email-change',
  '/account-deletion',
];

const PRIVATE_ROUTES = [
  '/',
  '/settings',
  '/moderation',
  '/calendar',
  '/search',
  '/lists',
  '/messages',
  '/notifications',
  '/stats',
  '/tracking',
  '/wrapped',
  '/media/550',
  '/episodes/1',
  '/profile/accessibility-user',
];

test('public pages meet WCAG A/AA checks', async ({ page }) => {
  for (const path of PUBLIC_ROUTES) {
    await page.goto(path);
    await expect(page.locator('h1')).toBeVisible();
    await expectNoAccessibilityViolations(page);
  }
});

// One test per page: auditing the rendered page rather than its loading
// spinner takes long enough that fourteen of them overran one test's timeout.
for (const path of PRIVATE_ROUTES) {
  test(`signed-in page ${path} meets WCAG A/AA checks`, async ({ page }) => {
    // A page that throws renders the error screen instead, which can pass the
    // audit on its own merits.
    const uiErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error' && message.text().startsWith('Unhandled UI error')) {
        uiErrors.push(message.text());
      }
    });
    await stubAuthenticatedApp(page);
    await page.goto(path);
    // The page itself, not the spinner its lazy route shows first. Waiting on
    // `main` alone audited the spinner whenever the page was slower than the
    // check, and missed that Notifications nested a second `main` in the
    // layout's: the strict locator only tripped on it when the page was faster.
    await expect(page.locator('main h1').first()).toBeVisible();
    await expect(page.locator('main')).toHaveCount(1);
    await expectNoAccessibilityViolations(page);
    expect(uiErrors).toEqual([]);
  });
}

test('report dialog is keyboard reachable and meets WCAG A/AA checks', async ({ page }) => {
  await stubAuthenticatedApp(page);
  await page.addInitScript(() => localStorage.setItem('cinetrack-theme', 'dark'));
  await page.goto('/profile/reported-user');
  const reportButton = page.getByRole('button', { name: 'Report @reported-user' });
  await reportButton.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Report content' })).toBeVisible();
  const closeButton = page.getByRole('button', { name: 'Close report form' });
  const submitButton = page.getByRole('button', { name: 'Submit report' });
  await expect(closeButton).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(submitButton).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(closeButton).toBeFocused();
  await expectNoAccessibilityViolations(page);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Report content' })).toBeHidden();
  await expect(reportButton).toBeFocused();
});
