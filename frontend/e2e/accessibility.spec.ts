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

test('signed-in pages meet WCAG A/AA checks', async ({ page }) => {
  await stubAuthenticatedApp(page);
  for (const path of PRIVATE_ROUTES) {
    await page.goto(path);
    await expect(page.locator('main')).toBeVisible();
    await expectNoAccessibilityViolations(page);
  }
});

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
