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

test('log a workout and the target for the day goes up by half of it', async ({ page }) => {
  await signUp(page);
  await onboard(page);
  const target = async () => Number((await page.locator('.label:text-is("Target") + div').innerText()).replace(/\D/g, ''));
  const before = await target();
  await page.getByRole('heading', { name: 'Exercise' }).locator('xpath=../..').getByRole('button', { name: 'Add' }).click();
  await page.getByRole('button', { name: 'Running' }).click();
  await page.getByLabel('Calories burned').fill('400');
  await page.getByRole('button', { name: /^Log · 400 kcal/ }).click();
  await expect(page.getByText('incl. +200 exercise')).toBeVisible();
  expect(await target()).toBe(before + 200);
});

async function quickAdd(page, name, kcal) {
  await page.getByRole('button', { name: 'Quick add' }).first().click();
  await page.getByPlaceholder('e.g. Pret chicken wrap').fill(name);
  await page.getByPlaceholder('kcal').fill(String(kcal));
  await page.getByRole('group', { name: 'Meal' }).getByRole('tab', { name: 'Breakfast' }).click();
  await page.getByRole('button', { name: new RegExp('^Add ' + kcal) }).click();
}

test('save breakfast as a meal, then add it again in one tap', async ({ page }) => {
  await signUp(page);
  await onboard(page);
  await quickAdd(page, 'Greek yoghurt', 150);
  await quickAdd(page, 'Granola', 180);
  await page.getByRole('button', { name: 'Save as meal' }).click();
  await page.getByLabel('Name').fill('Yoghurt bowl');
  await page.getByRole('button', { name: /^Save · 330 kcal/ }).click();
  /* the one-tap chip on Breakfast */
  await page.getByRole('button', { name: /Yoghurt bowl 330/ }).click();
  await expect(page.getByText('Added Yoghurt bowl')).toBeVisible();
  await expect(page.locator('.list-row', { hasText: 'Yoghurt bowl' })).toContainText('1 serving');
  /* and in Me */
  await page.goto('/?view=me');
  await expect(page.getByRole('heading', { name: 'Meals & recipes' })).toBeVisible();
  await expect(page.locator('.list-row', { hasText: 'Yoghurt bowl' })).toContainText('330 kcal per serving');
});

test('a batch recipe logs by the serving from search', async ({ page }) => {
  await signUp(page);
  await onboard(page);
  await page.getByRole('button', { name: 'Search' }).first().click();
  await page.getByRole('button', { name: 'New' }).click();
  await page.getByLabel('Name').fill('Chilli');
  await page.getByLabel('Makes').fill('4');
  await page.getByRole('button', { name: 'Add ingredient' }).click();
  await page.getByRole('button', { name: 'Enter calories by hand' }).click();
  await page.getByLabel('What').fill('Whole pot');
  await page.getByLabel('kcal', { exact: true }).fill('2000');
  await page.getByRole('dialog').getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('button', { name: /^Save · 500 kcal per serving/ }).click();
  await page.getByRole('button', { name: 'Search' }).first().click();
  await page.locator('.list-row', { hasText: 'Chilli' }).click();
  await page.getByRole('button', { name: '1½' }).click();
  await page.getByRole('button', { name: /^Add · 750 kcal/ }).click();
  await expect(page.locator('.list-row', { hasText: 'Chilli' })).toContainText('1½ servings');
});

test('exercise page shows totals, and the deficit includes exercise', async ({ page }) => {
  await signUp(page);
  await onboard(page);
  const deficit = async () => Number((await page.locator('.label:text-is("Deficit today") + div').innerText()).replace(/\D/g, ''));
  const before = await deficit();
  await page.getByRole('heading', { name: 'Exercise' }).locator('xpath=../..').getByRole('button', { name: 'Add' }).click();
  await page.getByRole('button', { name: 'Running' }).click();
  await page.getByLabel('Calories burned').fill('400');
  await page.getByRole('button', { name: /^Log · 400 kcal/ }).click();
  /* burned +400, target +200 → deficit (burned − eaten) +400 now, +200 if you eat to target */
  expect(await deficit()).toBe(before + 400);
  await page.getByRole('button', { name: 'See all' }).click();
  await expect(page.getByRole('heading', { name: 'Exercise', exact: true })).toBeVisible();
  await expect(page.locator('.tile', { hasText: 'Burned' })).toContainText('400');
  await expect(page.locator('.tile', { hasText: 'Extra deficit' })).toContainText('200');
  await expect(page.locator('.tile', { hasText: 'Workouts' })).toContainText('1');
});

test('every page fits an iPhone SE (375pt) with nothing cut off', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await signUp(page);
  await onboard(page);
  const check = async (label) => {
    const r = await page.evaluate(() => {
      const vw = innerWidth;
      const off = [...document.querySelectorAll('#app *, .scrim *')].filter((el) => { const b = el.getBoundingClientRect(); return b.width && (b.right > vw + 1 || b.left < -1); }).map((el) => el.tagName + '.' + el.className);
      const clipped = [...document.querySelectorAll('#app button, .scrim button')].filter((b) => b.getBoundingClientRect().width && b.scrollWidth > b.clientWidth + 2).map((b) => b.innerText);
      return { off: off.slice(0, 3), clipped: clipped.slice(0, 3), sideways: document.documentElement.scrollWidth > vw };
    });
    expect(r, label).toEqual({ off: [], clipped: [], sideways: false });
  };
  await check('today');
  for (const v of ['progress', 'exercise', 'insights', 'me']) {
    await page.goto('/?view=' + v);
    await page.waitForSelector('.page h1');
    await page.evaluate(() => document.querySelectorAll('details').forEach((d) => { d.open = true; }));
    await check(v);
  }
  await page.goto('/?view=today');
  await page.getByRole('button', { name: 'Search' }).first().click();
  await check('add sheet');
  await page.getByRole('button', { name: 'New' }).click();
  await check('recipe editor');
});

test('opening an invite link goes straight to sign-up with the code filled in', async ({ page, request }) => {
  /* someone already in makes a link */
  const ctx = page.context();
  await signUp(page);
  const { url, code } = await page.evaluate(() => fetch('/api/invites', { method: 'POST', headers: { 'X-Tally': '1', 'Content-Type': 'application/json' }, body: '{}' }).then(r => r.json()));
  await ctx.clearCookies();
  await page.evaluate(() => localStorage.clear());
  /* a friend opens it */
  await page.goto(new URL(url).pathname + new URL(url).search);
  await expect(page.getByText('You’ve been invited')).toBeVisible();
  await expect(page.getByLabel('Invite code')).toHaveValue(code);
  await page.getByLabel('Email').fill('friend' + Date.now() + '@tally.test');
  await page.getByLabel('Password').fill('friend-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.locator('.code')).toBeVisible();
  expect(new URL(page.url()).search).toBe('');
});
