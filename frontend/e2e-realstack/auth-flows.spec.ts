import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { BACKEND_LOG, FRONTEND_ORIGIN } from '../playwright.realstack.config';

/**
 * Real-stack auth E2E — runs against the live backend + Postgres. Each test
 * registers its own throwaway account (the DB is ephemeral) so the specs are
 * independent and order-free.
 */

const BASE = `${FRONTEND_ORIGIN}/`;
const PASSWORD = 'Passw0rd123';

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function uniqueAccount() {
  const id = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  return { username: `e2e${id}`, email: `e2e${id}@example.com`, password: PASSWORD };
}

async function registerViaUi(
  page: Page,
  acct: { username: string; email: string; password: string }
) {
  await page.goto('/register');
  await page.locator('input[type="text"]').fill(acct.username);
  await page.locator('input[type="email"]').fill(acct.email);
  await page.locator('input[type="password"]').fill(acct.password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('button', { name: 'Logout' })).toBeVisible();
}

async function loginViaUi(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** Read a one-time email token the backend logs when SMTP is unconfigured. */
async function waitForEmailToken(email: string, subject: string): Promise<string> {
  const logPath = resolve(process.cwd(), BACKEND_LOG);
  const pattern = new RegExp(
    `to=${escapeRegex(email)}\\b[^\\n]*subject="${escapeRegex(subject)}"[^\\n]*token=([0-9a-f]{128})`,
    'g',
  );
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const log = readFileSync(logPath, 'utf8');
      const matches = [...log.matchAll(pattern)];
      if (matches.length) return matches[matches.length - 1][1];
    } catch {
      // log file not created yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${subject} token for ${email} not found in ${BACKEND_LOG}`);
}

async function verifyEmailViaUi(page: Page, email: string) {
  const token = await waitForEmailToken(email, 'Confirm your Văzute email');
  await page.goto(`/verify-email#token=${token}`);
  await expect(page.getByText('Your email is confirmed. Thanks!')).toBeVisible();
}

test('register issues an HttpOnly refresh cookie and reaches the dashboard', async ({
  page,
  context,
}) => {
  const acct = uniqueAccount();
  await registerViaUi(page, acct);
  await expect(page).toHaveURL(BASE);

  const refresh = (await context.cookies()).find((c) => c.name === 'cinetrack_refresh');
  expect(refresh, 'refresh cookie should be set').toBeTruthy();
  expect(refresh!.httpOnly).toBe(true);
  expect(refresh!.sameSite).toBe('Strict');
});

test('restores a reloaded session using only the HttpOnly cookie', async ({ page, context }) => {
  const acct = uniqueAccount();
  await registerViaUi(page, acct);

  const before = (await context.cookies()).find((cookie) => cookie.name === 'cinetrack_refresh');
  expect(before).toBeTruthy();
  expect(await page.evaluate(() => localStorage.getItem('cinetrack-auth'))).toBeNull();

  await page.reload();

  await expect(page).toHaveURL(BASE);
  await expect(page.getByRole('button', { name: 'Logout' })).toBeVisible();
  const after = (await context.cookies()).find((cookie) => cookie.name === 'cinetrack_refresh');
  expect(after).toBeTruthy();
  expect(after!.value).not.toBe(before!.value);
  expect(await page.evaluate(() => localStorage.getItem('cinetrack-auth'))).toBeNull();
});

test('lists the current device under active sessions', async ({ page }) => {
  await registerViaUi(page, uniqueAccount());
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Active sessions' })).toBeVisible();
  await expect(page.getByText('This device')).toBeVisible();
});

test('private profiles require an approved follow request', async ({ browser }) => {
  const ownerContext = await browser.newContext({ baseURL: BASE });
  const followerContext = await browser.newContext({ baseURL: BASE });
  const ownerPage = await ownerContext.newPage();
  const followerPage = await followerContext.newPage();

  try {
    const owner = uniqueAccount();
    await registerViaUi(ownerPage, owner);
    await verifyEmailViaUi(ownerPage, owner.email);
    await ownerPage.goto('/settings');

    // Accounts start private and only a confirmed address may go public, so the
    // switch is already on. Toggling both ways proves the confirmed owner can
    // still change visibility, and leaves the profile private for the follow
    // request below.
    const privacy = ownerPage.getByRole('switch', { name: 'Private profile' });
    await expect(privacy).toHaveAttribute('aria-checked', 'true');
    await privacy.click();
    await expect(privacy).toHaveAttribute('aria-checked', 'false');
    await privacy.click();
    await expect(privacy).toHaveAttribute('aria-checked', 'true');

    const follower = uniqueAccount();
    await registerViaUi(followerPage, follower);
    await verifyEmailViaUi(followerPage, follower.email);
    await followerPage.goto(`/profile/${owner.username}`);
    await expect(followerPage.getByText('Private', { exact: true })).toBeVisible();
    await expect(followerPage.getByText(/accepted follow request is required/i)).toBeVisible();
    await followerPage.getByRole('button', { name: 'Request to follow' }).click();
    await expect(followerPage.getByRole('button', { name: 'Request sent' })).toBeVisible();

    await ownerPage.reload();
    await expect(ownerPage.getByText(/Follow requests/i)).toBeVisible();
    await expect(ownerPage.getByText(follower.username, { exact: true })).toBeVisible();
    const requestBell = ownerPage.getByRole('button', {
      name: 'Notifications, 1 unread notification',
    });
    await expect(requestBell).toBeVisible();
    await requestBell.click();
    await expect(ownerPage.getByText('requested to follow you')).toBeVisible();
    await ownerPage.keyboard.press('Escape');
    await ownerPage
      .getByRole('button', { name: `Reject follow request from ${follower.username}` })
      .click();
    await expect(ownerPage.getByText(follower.username, { exact: true })).toHaveCount(0);

    await followerPage.reload();
    await followerPage.getByRole('button', { name: 'Request to follow' }).click();
    await expect(followerPage.getByRole('button', { name: 'Request sent' })).toBeVisible();

    await ownerPage.reload();
    await ownerPage
      .getByRole('button', { name: `Accept follow request from ${follower.username}` })
      .click();
    await expect(ownerPage.getByRole('button', { name: /Accept follow request from/ })).toHaveCount(0);

    await followerPage.reload();
    await expect(followerPage.getByRole('button', { name: 'Unfollow' })).toBeVisible();
    await expect(followerPage.getByText(/accepted follow request is required/i)).toHaveCount(0);
    const acceptedBell = followerPage.getByRole('button', {
      name: 'Notifications, 1 unread notification',
    });
    await expect(acceptedBell).toBeVisible();
    await acceptedBell.click();
    await expect(followerPage.getByText('accepted your follow request')).toBeVisible();
    await followerPage.getByRole('link', { name: 'View all notifications' }).click();
    await followerPage.getByRole('button', { name: 'Mark all as read' }).click();
    await expect(followerPage.getByText('You are all caught up.')).toBeVisible();
  } finally {
    await ownerContext.close();
    await followerContext.close();
  }
});

test('deleting the account logs out and blocks re-login', async ({ page }) => {
  const acct = uniqueAccount();
  await registerViaUi(page, acct);

  await page.goto('/settings');
  await page.getByRole('button', { name: 'Delete my account' }).click();
  // The confirm field is autofocused when the danger zone expands.
  await page.locator('input:focus').fill(acct.password);
  await page.getByRole('button', { name: 'Permanently delete' }).click();
  await expect(page).toHaveURL(/\/login$/);

  await loginViaUi(page, acct.email, acct.password);
  await expect(page.getByText('Invalid email or password')).toBeVisible();
});

test('resets the password with the emailed token and signs in with it', async ({ page }) => {
  const acct = uniqueAccount();
  await registerViaUi(page, acct);
  await page.getByRole('button', { name: 'Logout' }).click();
  await expect(page).toHaveURL(/\/login$/);

  await page.goto('/forgot-password');
  await page.locator('input[type="email"]').fill(acct.email);
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByText(/reset link is on its way/i)).toBeVisible();

  const token = await waitForEmailToken(acct.email, 'Reset your Văzute password');
  const newPassword = 'NewPassw0rd456';
  await page.goto(`/reset-password#token=${token}`);
  await expect(page).toHaveURL(/\/reset-password$/);
  const passwords = page.locator('input[type="password"]');
  await passwords.nth(0).fill(newPassword);
  await passwords.nth(1).fill(newPassword);
  await page.getByRole('button', { name: 'Set new password' }).click();
  await expect(page.getByText(/Password updated/i)).toBeVisible();

  await loginViaUi(page, acct.email, newPassword);
  await expect(page).toHaveURL(BASE);
  await expect(page.getByRole('button', { name: 'Logout' })).toBeVisible();
});
