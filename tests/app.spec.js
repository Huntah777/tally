import { test, expect } from '@playwright/test';
import { INVITE } from '../playwright.config.js';

const unique = () => `ui${Date.now()}${Math.random().toString(36).slice(2, 6)}@tally.test`;
const PASSWORD = 'ui-test-password';

/* Signs up through the UI and dismisses the recovery-code sheet. */
async function signUp(page, email = unique()) {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Create account' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByLabel('Invite code').fill(INVITE);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.locator('.code')).toHaveText(/^[A-Z2-9-]{19}$/);
  await page.getByRole('button', { name: 'I’ve saved it' }).click();
  return email;
}

async function onboard(page) {
  await page.getByLabel('Year of birth').fill('1990');
  await page.getByPlaceholder('170').fill('175');
  await page.getByRole('button', { name: 'Continue' }).click();
  const [current, goal] = await page.getByPlaceholder('0.0').all();
  await current.fill('90');
  await goal.fill('78');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Your daily target')).toBeVisible();
  await page.getByRole('button', { name: 'Start tracking' }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
}

test('sign up → onboarding → quick add → it persists across reload', async ({ page }) => {
  await signUp(page);
  await onboard(page);
  await page.getByRole('button', { name: 'Quick add' }).first().click();
  await page.getByPlaceholder('e.g. Pret chicken wrap').fill('Test wrap');
  await page.getByPlaceholder('kcal').fill('450');
  await page.getByRole('button', { name: /^Add 450 kcal/ }).click();
  await expect(page.getByText('Test wrap')).toBeVisible();
  await expect(page.getByText('Synced')).toBeVisible({ timeout: 8000 }).catch(() => {}); /* sidebar hidden on phones */
  await page.waitForTimeout(1800);
  await page.evaluate(() => localStorage.clear());   /* prove it came from the server */
  await page.reload();
  await expect(page.getByText('Test wrap')).toBeVisible();
});

test('log a weigh-in and see it on Progress', async ({ page }) => {
  await signUp(page);
  await onboard(page);
  await page.goto('/?view=progress');
  await expect(page.getByRole('heading', { name: 'Progress' })).toBeVisible();
  await expect(page.getByText('90.0 kg').first()).toBeVisible();
});

test('passkey: register, sign out, sign back in with it', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'virtual authenticator is Chromium-only');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
  } });

  const email = await signUp(page);
  await onboard(page);
  await page.goto('/?view=me');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('Passkey added.')).toBeVisible();

  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('button', { name: 'Sign in with passkey' }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
  await page.goto('/?view=me');
  await expect(page.getByText(email)).toBeVisible();
});

test('height can be entered in feet and inches, whatever the weight unit', async ({ page }) => {
  await signUp(page);
  await page.getByLabel('Year of birth').fill('1990');
  await page.getByRole('tab', { name: 'ft & in' }).click();
  await page.getByLabel('Feet').fill('5');
  await page.getByLabel('Inches').fill('9');
  /* switching back shows the same height in cm, and the weight unit is untouched */
  await page.getByRole('tab', { name: 'cm', exact: true }).click();
  await expect(page.getByLabel('Height in centimetres')).toHaveValue('175');
  await expect(page.getByRole('tab', { name: 'kg', exact: true })).toHaveAttribute('aria-selected', 'true');
  /* 6 ft exactly round-trips without becoming "5 ft 12 in" */
  await page.getByLabel('Height in centimetres').fill('183');
  await page.getByRole('tab', { name: 'ft & in' }).click();
  await expect(page.getByLabel('Feet')).toHaveValue('6');
  await expect(page.getByLabel('Inches')).toHaveValue('0');
  /* tapping the caption doesn't flip the unit */
  await page.getByText('Height', { exact: true }).click();
  await expect(page.getByLabel('Feet')).toBeVisible();
});
