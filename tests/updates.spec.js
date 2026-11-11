import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { INVITE } from '../playwright.config.js';

/* Simulates a deploy while the app is open: rebuild dist/ (new build id,
   new sw.js) and check the open page moves itself onto it — and that it
   never does so while someone is mid-entry. Runs after the other projects
   because rebuilding changes what every open page would see. */
test.describe.configure({ mode: 'serial' });

const deploy = () => execSync('node scripts/build.mjs', { stdio: 'pipe' });
const build = (page) => page.evaluate(() => window.__TALLY_BUILD__);
const deployed = async (page) => (await (await page.request.get('/version.json')).json()).build;

async function signedInApp(page) {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Create account' }).click();
  await page.getByLabel('Email').fill(`upd${Date.now()}@tally.test`);
  await page.getByLabel('Password').fill('update-test-pw');
  await page.getByLabel('Invite code').fill(INVITE);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('button', { name: 'I’ve saved it' }).click();
  /* Wait for the service worker to control the page, as on a real install. */
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15000 });
}

test('a new deploy is picked up without clearing anything', async ({ page }) => {
  await signedInApp(page);
  const before = await build(page);
  expect(before).toBe(await deployed(page));

  deploy();
  const after = await deployed(page);
  expect(after).not.toBe(before);

  await page.evaluate(() => window.TallyUpdates.check());
  await page.waitForFunction((b) => window.__TALLY_BUILD__ === b, after, { timeout: 20000 });
  /* still signed in, still working */
  await expect(page.getByText('About you').or(page.getByRole('heading', { name: 'Today' }))).toBeVisible();
});

test('it never reloads mid-entry: it waits, shows a pill, then switches', async ({ page }) => {
  await signedInApp(page);
  const before = await build(page);

  /* Mid-entry: typing in onboarding (a field has focus). */
  await page.getByLabel('Year of birth').fill('1990');
  await page.getByLabel('Year of birth').focus();

  deploy();
  const after = await deployed(page);
  await page.evaluate(() => window.TallyUpdates.check());

  await expect(page.getByText('New version ready')).toBeVisible({ timeout: 20000 });
  expect(await build(page)).toBe(before);                    /* not yanked away */
  await expect(page.getByLabel('Year of birth')).toHaveValue('1990');

  /* Done typing → it switches by itself. */
  await page.getByLabel('Year of birth').blur();
  await page.waitForFunction((b) => window.__TALLY_BUILD__ === b, after, { timeout: 20000 });
});

test('the version and a repair button are in Me', async ({ page }) => {
  await signedInApp(page);
  await page.evaluate(() => { window.__noReload = true; });
  /* Skip onboarding by saving a minimal profile. */
  await page.evaluate(() => fetch('/api/state', { method: 'PUT', headers: { 'X-Tally': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile: { units: 'kg', sex: 'male', heightCm: 180, birthYear: 1990, startKg: 90, goalKg: 80, done: true, updated: Date.now() } }) }));
  await page.evaluate(() => localStorage.clear());
  await page.goto('/?view=me');
  await expect(page.getByRole('button', { name: 'Repair app' })).toBeVisible();
  await page.getByRole('button', { name: 'Check for updates' }).click();
  await expect(page.getByText('You’re on the latest version.')).toBeVisible();
});

test('if the app cannot start, it offers a repair instead of a blank screen', async ({ page }) => {
  test.setTimeout(45000);
  /* Break startup the way a bad cache would: the compiler never arrives. */
  await page.route('**/vendor/babel.min.js', (r) => r.abort());
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Tally didn’t start' })).toBeVisible({ timeout: 20000 });
  await page.unroute('**/vendor/babel.min.js');
  await page.getByRole('button', { name: 'Repair app' }).click();
  await expect(page.getByRole('tab', { name: 'Create account' })).toBeVisible({ timeout: 20000 });
});
