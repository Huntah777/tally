import { test, expect, request as pwRequest } from '@playwright/test';
import { INVITE } from '../playwright.config.js';

/* Every test makes its own users, so specs can run in parallel against one
   local D1. */
const H = { 'X-Tally': '1' };
const unique = () => `u${Date.now()}${Math.random().toString(36).slice(2, 7)}@tally.test`;

async function newUser(baseURL, password = 'correct-horse-battery') {
  const ctx = await pwRequest.newContext({ baseURL });
  const email = unique();
  const r = await ctx.post('/api/auth/signup', { headers: H, data: { email, password, invite: INVITE } });
  expect(r.status()).toBe(201);
  return { ctx, email, password, body: await r.json() };
}

test('signup returns a recovery code and a session', async ({ baseURL }) => {
  const { ctx, email, body } = await newUser(baseURL);
  expect(body.recoveryCode).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
  const me = await (await ctx.get('/api/auth/me', { headers: H })).json();
  expect(me.user.email).toBe(email);
});

test('duplicate email, short password and bad email are refused', async ({ baseURL }) => {
  const { email } = await newUser(baseURL);
  const ctx = await pwRequest.newContext({ baseURL });
  expect((await ctx.post('/api/auth/signup', { headers: H, data: { email, password: 'whatever-long', invite: INVITE } })).status()).toBe(409);
  expect((await ctx.post('/api/auth/signup', { headers: H, data: { email: unique(), password: 'short', invite: INVITE } })).status()).toBe(400);
  expect((await ctx.post('/api/auth/signup', { headers: H, data: { email: 'not-an-email', password: 'long-enough-pw', invite: INVITE } })).status()).toBe(400);
});

test('login, wrong password, logout', async ({ baseURL }) => {
  const { email, password } = await newUser(baseURL);
  const ctx = await pwRequest.newContext({ baseURL });
  expect((await ctx.post('/api/auth/login', { headers: H, data: { email, password: 'nope-nope' } })).status()).toBe(401);
  expect((await ctx.post('/api/auth/login', { headers: H, data: { email: email.toUpperCase(), password } })).status()).toBe(200);
  expect((await ctx.get('/api/state', { headers: H })).status()).toBe(200);
  await ctx.post('/api/auth/logout', { headers: H });
  expect((await ctx.get('/api/state', { headers: H })).status()).toBe(401);
});

test('writes without the X-Tally header are rejected (CSRF)', async ({ baseURL }) => {
  const { ctx } = await newUser(baseURL);
  expect((await ctx.put('/api/state', { data: {} })).status()).toBe(403);
});

test('each user only ever sees their own data', async ({ baseURL }) => {
  const a = await newUser(baseURL), b = await newUser(baseURL);
  await a.ctx.put('/api/state', { headers: H, data: { entries: [{ id: 'secret', name: 'A only', kcal: 1, updated: 1 }] } });
  const bs = await (await b.ctx.get('/api/state', { headers: H })).json();
  expect(JSON.stringify(bs)).not.toContain('A only');
  const as = await (await a.ctx.get('/api/state', { headers: H })).json();
  expect(as.entries[0].name).toBe('A only');
});

test('state merges concurrent writes instead of clobbering, and honours tombstones', async ({ baseURL }) => {
  const { ctx } = await newUser(baseURL);
  await ctx.put('/api/state', { headers: H, data: { entries: [{ id: 'phone', kcal: 1, updated: 5 }] } });
  await ctx.put('/api/state', { headers: H, data: { entries: [{ id: 'laptop', kcal: 2, updated: 6 }] } });
  let s = await (await ctx.get('/api/state', { headers: H })).json();
  expect(s.entries.map((e) => e.id).sort()).toEqual(['laptop', 'phone']);
  await ctx.put('/api/state', { headers: H, data: { entriesDeleted: [{ id: 'phone', deletedAt: Date.now() }] } });
  s = await (await ctx.get('/api/state', { headers: H })).json();
  expect(s.entries.map((e) => e.id)).toEqual(['laptop']);
});

test('ETag gives 304 when nothing changed', async ({ baseURL }) => {
  const { ctx } = await newUser(baseURL);
  await ctx.put('/api/state', { headers: H, data: { ui: { x: 1 } } });
  const first = await ctx.get('/api/state', { headers: H });
  const again = await ctx.get('/api/state', { headers: { ...H, 'If-None-Match': first.headers().etag } });
  expect(again.status()).toBe(304);
});

test('recovery code resets the password once, then is replaced', async ({ baseURL }) => {
  const { email, body } = await newUser(baseURL);
  const ctx = await pwRequest.newContext({ baseURL });
  const r = await ctx.post('/api/auth/recover', { headers: H, data: { email, code: body.recoveryCode.toLowerCase(), password: 'brand-new-pass' } });
  expect(r.status()).toBe(200);
  const fresh = (await r.json()).recoveryCode;
  expect(fresh).not.toBe(body.recoveryCode);
  expect((await ctx.post('/api/auth/recover', { headers: H, data: { email, code: body.recoveryCode, password: 'another-pass-1' } })).status()).toBe(401);
  expect((await ctx.post('/api/auth/login', { headers: H, data: { email, password: 'brand-new-pass' } })).status()).toBe(200);
});

test('repeated wrong passwords are throttled', async ({ baseURL }) => {
  const { email } = await newUser(baseURL);
  const ctx = await pwRequest.newContext({ baseURL });
  let last;
  for (let i = 0; i < 9; i++) last = await ctx.post('/api/auth/login', { headers: H, data: { email, password: 'wrong-' + i } });
  expect(last.status()).toBe(429);
});

test('food endpoints need a session', async ({ baseURL }) => {
  const ctx = await pwRequest.newContext({ baseURL });
  expect((await ctx.get('/api/food/search?q=milk', { headers: H })).status()).toBe(401);
  expect((await ctx.get('/api/food/barcode?code=5000159484695', { headers: H })).status()).toBe(401);
});

test('deleting the account removes the user and their data', async ({ baseURL }) => {
  const { ctx, email, password } = await newUser(baseURL);
  await ctx.put('/api/state', { headers: H, data: { entries: [{ id: 'x', kcal: 1, updated: 1 }] } });
  expect((await ctx.post('/api/auth/delete', { headers: H, data: { password } })).status()).toBe(200);
  const again = await pwRequest.newContext({ baseURL });
  expect((await again.post('/api/auth/login', { headers: H, data: { email, password } })).status()).toBe(401);
});

test('invite-only: health says so, and missing or wrong codes are refused', async ({ baseURL }) => {
  const ctx = await pwRequest.newContext({ baseURL });
  expect((await (await ctx.get('/api/health')).json()).invite).toBe(true);
  const email = unique();
  const missing = await ctx.post('/api/auth/signup', { headers: H, data: { email, password: 'long-enough-pw' } });
  expect(missing.status()).toBe(403);
  expect((await missing.json()).field).toBe('invite');
  expect((await ctx.post('/api/auth/signup', { headers: H, data: { email, password: 'long-enough-pw', invite: 'guess' } })).status()).toBe(403);
  /* case and surrounding spaces don't matter — people type these on phones */
  expect((await ctx.post('/api/auth/signup', { headers: H, data: { email, password: 'long-enough-pw', invite: '  ' + INVITE.toUpperCase() + ' ' } })).status()).toBe(201);
});

test.describe('Apple Health sync', () => {
  async function withKey(baseURL) {
    const u = await newUser(baseURL);
    const r = await u.ctx.post('/api/tokens', { headers: H, data: {} });
    expect(r.status()).toBe(201);
    return { ...u, key: (await r.json()).token };
  }
  const ingest = (ctx, key, data) => ctx.post('/api/ingest', { headers: { Authorization: 'Bearer ' + key }, data });

  test('accepts what Shortcuts sends, and re-running replaces the day', async ({ baseURL }) => {
    const { ctx, key } = await withKey(baseURL);
    const r = await ingest(ctx, key, { date: '2026-11-10', activeKcal: ['300.5 kcal', '212 kcal'], steps: '9,412', weight: '126.4 kg', bodyFat: '0.356' });
    expect(r.status()).toBe(200);
    expect((await r.json()).saved).toEqual({ activeKcal: 513, steps: 9412, weightKg: 126.4, bodyFatPct: 35.6 });
    await ingest(ctx, key, { date: '2026-11-10', activeKcal: 640 });
    const s = await (await ctx.get('/api/state', { headers: H })).json();
    const day = s.exercise.filter((x) => x.date === '2026-11-10');
    expect(day).toHaveLength(1);
    expect(day[0]).toMatchObject({ kind: 'health', activeKcal: 640, steps: 9412 });
    expect(s.weights.find((w) => w.date === '2026-11-10')).toMatchObject({ kg: 126.4, fatPct: 35.6, source: 'apple-health' });
  });

  test('pounds are converted, and a weigh-in typed into Tally beats the Health one', async ({ baseURL }) => {
    const { ctx, key } = await withKey(baseURL);
    await ctx.put('/api/state', { headers: H, data: { weights: [{ id: 'w:2026-11-09', date: '2026-11-09', kg: 120, source: 'manual', updated: 1 }] } });
    await ingest(ctx, key, { date: '2026-11-09', weight: '280 lb', bodyFat: '35%' });
    await ingest(ctx, key, { date: '2026-11-08', weight: '280 lb' });
    const s = await (await ctx.get('/api/state', { headers: H })).json();
    expect(s.weights.find((w) => w.date === '2026-11-09')).toMatchObject({ kg: 120, fatPct: 35 });
    expect(s.weights.find((w) => w.date === '2026-11-08').kg).toBeCloseTo(127.0, 1);
  });

  test('bad keys, bad dates and empty bodies are refused; revoked keys stop working', async ({ baseURL }) => {
    const { ctx, key } = await withKey(baseURL);
    expect((await ingest(ctx, 'tly_nope', { steps: 1 })).status()).toBe(401);
    expect((await ctx.post('/api/ingest', { data: { steps: 1 } })).status()).toBe(401);
    expect((await ingest(ctx, key, { date: '11/10/2026', steps: 1 })).status()).toBe(400);
    expect((await ingest(ctx, key, { steps: 'none' })).status()).toBe(400);
    const list = await (await ctx.get('/api/tokens', { headers: H })).json();
    expect(list.tokens[0].last_used).toBeNull();
    await ctx.delete('/api/tokens?id=' + encodeURIComponent(list.tokens[0].id), { headers: H });
    expect((await ingest(ctx, key, { steps: 1 })).status()).toBe(401);
  });

  test('the three-action Shortcut: key in the link, no date, raw sample lists', async ({ baseURL }) => {
    const u = await newUser(baseURL);
    const made = await (await u.ctx.post('/api/tokens', { headers: H, data: {} })).json();
    expect(made.url).toMatch(/\/api\/ingest\?key=tly_/);
    const r = await u.ctx.post(made.url, { data: {
      activeKcal: '0.4 kcal\n12.6 kcal\n300 kcal',            /* a list turned into text */
      weight: ['126.4 kg', '127.1 kg'],                         /* latest first */
    } });
    expect(r.status()).toBe(200);
    const body = await r.json();
    const londonToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    expect(body.date).toBe(londonToday);
    expect(body.saved).toMatchObject({ activeKcal: 313, weightKg: 126.4 });
  });

  test('a key only writes to its own account', async ({ baseURL }) => {
    const a = await withKey(baseURL), b = await newUser(baseURL);
    await ingest(a.ctx, a.key, { date: '2026-11-07', steps: 12345 });
    const bs = await (await b.ctx.get('/api/state', { headers: H })).json();
    expect(JSON.stringify(bs)).not.toContain('12345');
  });
});
