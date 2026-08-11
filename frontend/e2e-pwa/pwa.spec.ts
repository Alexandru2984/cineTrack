import { expect, test, type Page } from '@playwright/test';

const TEST_USER = {
  id: '00000000-0000-0000-0000-000000000001',
  username: 'pwa_user',
  email: 'pwa@mailbox.dev',
  avatar_url: null,
  bio: null,
  is_public: true,
  email_verified: true,
  two_factor_enabled: false,
  created_at: '2026-01-01T00:00:00Z',
};

async function stubAuthenticatedShell(page: Page) {
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;

    if (request.method() === 'POST' && path === '/api/auth/refresh') {
      return route.fulfill({
        json: {
          access_token: 'pwa-access-token',
          token_type: 'Bearer',
          expires_in: 3600,
          user: TEST_USER,
        },
      });
    }
    if (path === '/api/notifications') {
      return route.fulfill({ json: { items: [], unread_count: 0, has_more: false } });
    }
    if (path === '/api/calendar/up-next') {
      return route.fulfill({ json: { items: [] } });
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
    return route.fulfill({ json: [] });
  });
}

test('loads the installable shell without browser console noise', async ({ page }) => {
  const consoleProblems: string[] = [];

  await stubAuthenticatedShell(page);
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      consoleProblems.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => {
    consoleProblems.push(`pageerror: ${error.message}`);
  });

  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Settings', exact: true })).toBeVisible();
  await page.waitForLoadState('networkidle');

  expect(consoleProblems).toEqual([]);
});

test('ships an installable manifest with adaptive icons', async ({ page, request }) => {
  const response = await request.get('/manifest.webmanifest');
  expect(response.ok()).toBe(true);
  expect(response.headers()['content-type']).toContain('application/manifest+json');

  const manifest = await response.json();
  expect(manifest).toMatchObject({
    id: '/',
    name: 'Văzute',
    short_name: 'Văzute',
    start_url: '/',
    scope: '/',
    display: 'standalone',
  });
  expect(manifest.icons).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ sizes: '192x192' }),
      expect.objectContaining({ sizes: '512x512', purpose: 'any' }),
      expect.objectContaining({ sizes: '512x512', purpose: 'maskable' }),
    ]),
  );

  await page.goto('/login');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    'href',
    '/manifest.webmanifest',
  );
});

test('publishes the Android app-link association', async ({ request }) => {
  const response = await request.get('/.well-known/assetlinks.json');
  expect(response.ok()).toBe(true);
  expect(response.headers()['content-type']).toContain('application/json');
  expect(await response.json()).toEqual([
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: 'com.micutu.vazute',
        sha256_cert_fingerprints: [
          // Play re-signs every bundle with its own key, so this one is what
          // store installs actually present. The upload key below only covers
          // builds installed directly.
          '6B:01:CD:93:4F:E4:09:F9:B6:70:71:5C:9F:D5:77:51:CB:6B:7C:8E:F4:C5:65:86:35:17:FB:6B:DA:42:CD:5C',
          '25:24:D5:B1:54:25:45:1E:00:1C:6B:8E:65:A4:F5:19:58:E5:B0:A3:4C:A5:35:0A:41:58:BD:7A:10:63:60:0F',
        ],
      },
    },
  ]);
});

test('registers the service worker and launches its shell offline', async ({
  context,
  page,
}) => {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();

  const scope = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return registration.scope;
  });
  expect(scope).toBe('http://127.0.0.1:4173/');

  await page.reload();
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true);

  const cachedUrls = await page.evaluate(async () => {
    const cacheNames = await caches.keys();
    const requests = await Promise.all(
      cacheNames.map(async (cacheName) => {
        const cache = await caches.open(cacheName);
        return cache.keys();
      }),
    );
    return requests.flat().map((request) => request.url);
  });
  expect(cachedUrls.some((url) => new URL(url).pathname.startsWith('/api/'))).toBe(false);

  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();

  // Network emulation and the browser's online/offline DOM events are separate
  // concerns. Exercise both explicitly so the cached-shell assertion does not
  // depend on a browser-specific navigator.onLine implementation.
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect(page.getByRole('status')).toContainText('You are offline');
  await context.setOffline(false);
});
