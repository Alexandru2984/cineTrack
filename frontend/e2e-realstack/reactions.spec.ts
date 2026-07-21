import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { DATABASE_URL } from '../playwright.realstack.config';

/**
 * End-to-end for episode reactions against a live backend and database.
 *
 * The feature has unit coverage on both clients and an integration test that
 * drives the HTTP flow, but nothing yet proves the wired-up web UI actually
 * reads and writes reactions through the real stack. That is the gap this
 * closes: a user watches an episode, reacts, changes their mind, sees the
 * aggregate, and removes it — all through the rendered page.
 *
 * The benchmark showed discovery returns nothing here (dummy TMDB key), so the
 * episode is seeded straight into the database rather than browsed to.
 */

const PASSWORD = 'Passw0rd123';

function sql(statement: string): string {
  // psql is on GitHub's ubuntu runners and on the dev host; the realstack
  // config already requires a reachable database at this URL.
  return execFileSync('psql', [DATABASE_URL, '-tAc', statement], {
    encoding: 'utf8',
  }).trim();
}

function uniqueAccount() {
  const id = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  return { username: `rx${id}`, email: `rx${id}@example.com`, password: PASSWORD };
}

async function registerAndVerify(page: Page, acct: ReturnType<typeof uniqueAccount>) {
  await page.goto('/register');
  await page.locator('input[type="text"]').fill(acct.username);
  await page.locator('input[type="email"]').fill(acct.email);
  await page.locator('input[type="password"]').fill(acct.password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('button', { name: 'Logout' })).toBeVisible();
}

/** Seed one aired episode of one show, mark it watched by the user, return its id. */
function seedWatchedEpisode(email: string): string {
  const userId = sql(`SELECT id FROM users WHERE email = '${email}'`);
  const tmdbId = 9500000 + Math.floor(Math.random() * 90000);

  const mediaId = randomUUID();
  const seasonId = randomUUID();
  const episodeId = randomUUID();

  sql(
    `INSERT INTO media (id, tmdb_id, media_type, title, status)
     VALUES ('${mediaId}', ${tmdbId}, 'tv', 'Reactions E2E Show', 'Ended');
     INSERT INTO seasons (id, media_id, season_number, episode_count)
     VALUES ('${seasonId}', '${mediaId}', 1, 1);
     INSERT INTO episodes (id, season_id, episode_number, name, air_date)
     VALUES ('${episodeId}', '${seasonId}', 1, 'The Reveal', CURRENT_DATE - 7);
     INSERT INTO user_media (user_id, media_id, status)
     VALUES ('${userId}', '${mediaId}', 'watching');
     INSERT INTO watch_history (user_id, media_id, episode_id)
     VALUES ('${userId}', '${mediaId}', '${episodeId}');`,
  );

  return episodeId;
}

test('a watched episode can be reacted to, changed and cleared through the UI', async ({
  page,
}) => {
  const acct = uniqueAccount();
  await registerAndVerify(page, acct);
  const episodeId = seedWatchedEpisode(acct.email);

  await page.goto(`/episodes/${episodeId}`);
  await expect(page.getByRole('heading', { name: 'How it landed' })).toBeVisible();

  // Watched, so reacting is allowed and the buttons are live.
  await expect(page.getByText('Be the first to react.')).toBeVisible();

  const loved = page.getByRole('button', { name: /^Loved it/ });
  await loved.click();

  // The aggregate updates: one reaction, and the button now carries its count.
  await expect(page.getByText('1 reaction')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Loved it, 1' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // Changing the reaction replaces rather than adds.
  await page.getByRole('button', { name: /^Shocked/ }).click();
  await expect(page.getByText('1 reaction')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Shocked, 1' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('button', { name: /^Loved it/ })).toHaveAttribute(
    'aria-pressed',
    'false',
  );

  // Tapping the active reaction clears it.
  await page.getByRole('button', { name: 'Shocked, 1' }).click();
  await expect(page.getByText('Be the first to react.')).toBeVisible();

  // And the database agrees — no orphaned row.
  const remaining = sql(
    `SELECT count(*) FROM episode_reactions WHERE episode_id = '${episodeId}'`,
  );
  expect(remaining).toBe('0');
});
