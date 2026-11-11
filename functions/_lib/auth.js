/* Shared helpers for Pages Functions. Not a route: Pages only routes files
   that export onRequest* handlers, so this module is bundled, never served.

   Accounts, not a shared token: unlike Command Deck and Folio, Tally is meant
   for more than one person, so every request resolves to a user through an
   HttpOnly session cookie and every row is keyed by that user. */

export const json = (data, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  });

export const SESSION_COOKIE = 'tally_session';
export const SESSION_TTL_MS = 60 * 24 * 60 * 60 * 1000;  /* 60 days, sliding */
const SESSION_REFRESH_MS    = 24 * 60 * 60 * 1000;       /* extend at most daily */
export const PBKDF2_ITER    = 100_000;                    /* Workers' PBKDF2 ceiling */

const enc = new TextEncoder();

/* ── encoding ── */
export const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
export const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const b64url = (buf) => b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const unb64url = (s) => {
  const t = String(s).replace(/-/g, '+').replace(/_/g, '/');
  return unb64(t + '='.repeat((4 - (t.length % 4)) % 4));
};
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));
export const randomId = (n = 16) => b64url(randomBytes(n));
export const sha256 = async (data) =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? enc.encode(data) : data));
export const sha256hex = async (s) => hex(await sha256(s));

/* Constant-time comparison of two byte arrays of equal length. */
export const bytesEqual = (a, b) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
};

/* ── passwords ── */
async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256,
  ));
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await pbkdf2(password, salt, PBKDF2_ITER);
  return { pw_hash: b64(hash), pw_salt: b64(salt), pw_iter: PBKDF2_ITER };
}

export async function verifyPassword(password, user) {
  const hash = await pbkdf2(password, unb64(user.pw_salt), user.pw_iter);
  return bytesEqual(hash, unb64(user.pw_hash));
}

/* Recovery codes: 4 groups of 4 from an alphabet without 0/O/1/I. */
const RC_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function newRecoveryCode() {
  const bytes = randomBytes(16);
  const chars = [...bytes].map((b) => RC_ALPHABET[b % RC_ALPHABET.length]).join('');
  return chars.match(/.{4}/g).join('-');
}
export const normaliseRecoveryCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const hashRecoveryCode = (c) => sha256hex('tally-recovery:' + normaliseRecoveryCode(c));

/* ── validation ── */
export const normaliseEmail = (e) => String(e || '').trim().toLowerCase();
export const emailOk = (e) => e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
export const passwordProblem = (p) => {
  if (typeof p !== 'string' || p.length < 8) return 'Use at least 8 characters';
  if (p.length > 200) return 'That password is too long';
  return null;
};

/* ── cookies & sessions ── */
const cookieOf = (request, name) => {
  const all = request.headers.get('Cookie') || '';
  for (const part of all.split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
};

/* `Secure` is dropped on plain-http localhost so `wrangler pages dev` works;
   every deployed origin is https. */
const cookieAttrs = (request, maxAgeSec) => {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
};

export const sessionCookie = (request, token) =>
  `${SESSION_COOKIE}=${token}${cookieAttrs(request, Math.floor(SESSION_TTL_MS / 1000))}`;
export const clearSessionCookie = (request) => `${SESSION_COOKIE}=${cookieAttrs(request, 0)}`;

const deviceLabel = (request) => {
  const ua = request.headers.get('User-Agent') || '';
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android'
    : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Device';
  const br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome'
    : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${br} on ${os}`;
};

/* Creates a session and returns the Set-Cookie header value for it. */
export async function startSession(request, env, userId) {
  const token = randomId(32);
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, label) VALUES (?, ?, ?, ?, ?)'
  ).bind(await sha256hex(token), userId, now, now + SESSION_TTL_MS, deviceLabel(request)).run();
  /* Opportunistic sweep so expired rows don't accumulate; cheap and indexed. */
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now).run();
  return sessionCookie(request, token);
}

export async function endSession(request, env) {
  const token = cookieOf(request, SESSION_COOKIE);
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256hex(token)).run();
}

/* Resolves the request's user, or null. Slides the expiry forward at most
   once a day so an active user never gets signed out, without a write on
   every request. */
export async function currentUser(request, env) {
  const token = cookieOf(request, SESSION_COOKIE);
  if (!token || token.length > 100) return null;
  const tokenHash = await sha256hex(token);
  const now = Date.now();
  const row = await env.DB.prepare(
    `SELECT s.user_id, s.expires_at, u.email FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ?`
  ).bind(tokenHash).first();
  if (!row || row.expires_at < now) return null;
  if (row.expires_at - now < SESSION_TTL_MS - SESSION_REFRESH_MS) {
    await env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?')
      .bind(now + SESSION_TTL_MS, tokenHash).run();
  }
  return { id: row.user_id, email: row.email, tokenHash };
}

/* CSRF: the cookie is SameSite=Lax, and every state-changing request must
   also carry a custom header, which a cross-site form or image can't send
   without a CORS preflight this origin never approves. */
export const csrfOk = (request) =>
  ['GET', 'HEAD', 'OPTIONS'].includes(request.method) || request.headers.get('X-Tally') === '1';

/* Wraps a handler so it only runs for a signed-in user. */
export const withUser = (handler) => async (ctx) => {
  if (!csrfOk(ctx.request)) return json({ error: 'Missing X-Tally header' }, 403);
  const user = await currentUser(ctx.request, ctx.env);
  if (!user) return json({ error: 'Unauthorized' }, 401);
  return handler({ ...ctx, user });
};

/* ── throttling ── */
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS_PER_EMAIL = 8;
const MAX_FAILS_PER_IP    = 30;

const clientIp = (request) => request.headers.get('CF-Connecting-IP') || 'local';

export async function throttled(request, env, email) {
  const since = Date.now() - FAIL_WINDOW_MS;
  const count = async (key) =>
    (await env.DB.prepare('SELECT COUNT(*) AS n FROM login_failures WHERE key = ? AND at > ?')
      .bind(key, since).first())?.n || 0;
  const [byEmail, byIp] = await Promise.all([
    email ? count('email:' + email) : 0,
    count('ip:' + clientIp(request)),
  ]);
  return byEmail >= MAX_FAILS_PER_EMAIL || byIp >= MAX_FAILS_PER_IP;
}

export async function recordFailure(request, env, email) {
  const now = Date.now();
  const stmts = [
    env.DB.prepare('INSERT INTO login_failures (key, at) VALUES (?, ?)').bind('ip:' + clientIp(request), now),
    env.DB.prepare('DELETE FROM login_failures WHERE at < ?').bind(now - FAIL_WINDOW_MS),
  ];
  if (email) stmts.push(env.DB.prepare('INSERT INTO login_failures (key, at) VALUES (?, ?)').bind('email:' + email, now));
  await env.DB.batch(stmts);
}

export const readJson = async (request, maxBytes = 16_384) => {
  const raw = await request.text();
  if (raw.length > maxBytes) throw new Error('too large');
  return JSON.parse(raw || '{}');
};
