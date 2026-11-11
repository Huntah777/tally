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
