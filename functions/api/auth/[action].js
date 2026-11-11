/* ============================================================
   Tally — /api/auth/:action
   ------------------------------------------------------------
   POST /api/auth/signup    { email, password, invite? } → { user, recoveryCode }
   POST /api/auth/login     { email, password }          → { user }
   POST /api/auth/logout                                 → { ok }
   GET  /api/auth/me                                     → { user, passkeys, sessions }
   POST /api/auth/password  { current, next }            → { ok }   (signs out other devices)
   POST /api/auth/recover   { email, code, password }    → { user, recoveryCode }
   POST /api/auth/delete    { password }                 → { ok }   (account + all data)

   Every POST must carry `X-Tally: 1` (see csrfOk). Errors from login and
   recover never say which of email/password/code was wrong.

   Optional env:
     SIGNUP_CODE   if set, signup requires { invite } to match — keeps a
                   public URL from becoming anyone's free calorie tracker.
   ============================================================ */
import {
  json, csrfOk, currentUser, startSession, endSession, clearSessionCookie,
  hashPassword, verifyPassword, newRecoveryCode, hashRecoveryCode,
  normaliseEmail, emailOk, passwordProblem, throttled, recordFailure, readJson, randomId,
  bytesEqual,
} from '../../_lib/auth.js';

const GENERIC_LOGIN_ERROR = 'That email and password don’t match';
const enc = new TextEncoder();

const userOut = (u) => ({ id: u.id, email: u.email });

async function signup({ request, env }) {
  const body = await readJson(request);
  const email = normaliseEmail(body.email);
  if (!emailOk(email)) return json({ error: 'Enter a valid email address' }, 400);
  const pwErr = passwordProblem(body.password);
  if (pwErr) return json({ error: pwErr }, 400);

  const invite = (env.SIGNUP_CODE || '').trim();
  if (invite) {
    const given = enc.encode(String(body.invite || '').trim());
    const want = enc.encode(invite);
    if (!bytesEqual(given, want)) return json({ error: 'That invite code isn’t right', field: 'invite' }, 403);
  }

  if (await env.DB.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first()) {
    return json({ error: 'An account with that email already exists — sign in instead' }, 409);
  }

  const id = randomId(16);
  const pw = await hashPassword(body.password);
  const recoveryCode = newRecoveryCode();
  await env.DB.prepare(
    `INSERT INTO users (id, email, pw_hash, pw_salt, pw_iter, recovery_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, email, pw.pw_hash, pw.pw_salt, pw.pw_iter, await hashRecoveryCode(recoveryCode), Date.now()).run();

  const cookie = await startSession(request, env, id);
  return json({ user: { id, email }, recoveryCode }, 201, { 'Set-Cookie': cookie });
}

async function login({ request, env }) {
  const body = await readJson(request);
  const email = normaliseEmail(body.email);
  if (await throttled(request, env, email)) {
    return json({ error: 'Too many attempts — wait 15 minutes and try again' }, 429);
  }
  const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  /* Hash even for an unknown email so response time doesn't reveal which
     addresses have accounts. */
  const ok = user
    ? await verifyPassword(String(body.password || ''), user)
    : (await hashPassword(String(body.password || '')), false);
  if (!ok) {
    await recordFailure(request, env, email);
    return json({ error: GENERIC_LOGIN_ERROR }, 401);
  }
  const cookie = await startSession(request, env, user.id);
  return json({ user: userOut(user) }, 200, { 'Set-Cookie': cookie });
}

async function logout({ request, env }) {
  await endSession(request, env);
  return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie(request) });
}

async function me({ request, env }) {
  const user = await currentUser(request, env);
  if (!user) return json({ user: null });
  const [passkeys, sessions] = await Promise.all([
    env.DB.prepare('SELECT id, name, created_at, last_used FROM passkeys WHERE user_id = ? ORDER BY created_at')
      .bind(user.id).all(),
    env.DB.prepare('SELECT token_hash, label, created_at FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC')
      .bind(user.id, Date.now()).all(),
  ]);
  return json({
    user: userOut(user),
    passkeys: passkeys.results || [],
    sessions: (sessions.results || []).map((s) => ({
      label: s.label, created_at: s.created_at, current: s.token_hash === user.tokenHash,
    })),
  });
}

async function changePassword({ request, env }) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'Unauthorized' }, 401);
  const body = await readJson(request);
  const row = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first();
  if (!await verifyPassword(String(body.current || ''), row)) return json({ error: 'Current password is wrong' }, 401);
  const pwErr = passwordProblem(body.next);
  if (pwErr) return json({ error: pwErr }, 400);
  const pw = await hashPassword(body.next);
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET pw_hash = ?, pw_salt = ?, pw_iter = ? WHERE id = ?')
      .bind(pw.pw_hash, pw.pw_salt, pw.pw_iter, user.id),
    /* A password change is often a response to a suspected compromise. */
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').bind(user.id, user.tokenHash),
  ]);
  return json({ ok: true });
}

async function recover({ request, env }) {
  const body = await readJson(request);
  const email = normaliseEmail(body.email);
  if (await throttled(request, env, email)) {
    return json({ error: 'Too many attempts — wait 15 minutes and try again' }, 429);
  }
  const pwErr = passwordProblem(body.password);
  if (pwErr) return json({ error: pwErr }, 400);
  const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  const given = enc.encode(await hashRecoveryCode(body.code));
  if (!user || !user.recovery_hash || !bytesEqual(given, enc.encode(user.recovery_hash))) {
    await recordFailure(request, env, email);
    return json({ error: 'That email and recovery code don’t match' }, 401);
  }
  /* The code is single use: issue a fresh one and show it once. */
  const pw = await hashPassword(body.password);
  const recoveryCode = newRecoveryCode();
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET pw_hash = ?, pw_salt = ?, pw_iter = ?, recovery_hash = ? WHERE id = ?')
      .bind(pw.pw_hash, pw.pw_salt, pw.pw_iter, await hashRecoveryCode(recoveryCode), user.id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
  ]);
  const cookie = await startSession(request, env, user.id);
  return json({ user: userOut(user), recoveryCode }, 200, { 'Set-Cookie': cookie });
}

async function deleteAccount({ request, env }) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'Unauthorized' }, 401);
  const body = await readJson(request);
  const row = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first();
  if (!await verifyPassword(String(body.password || ''), row)) return json({ error: 'Password is wrong' }, 401);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM state    WHERE user_id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM passkeys WHERE user_id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM users    WHERE id = ?').bind(user.id),
  ]);
  return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie(request) });
}

const POST = { signup, login, logout, password: changePassword, recover, delete: deleteAccount };
const GET  = { me };

export async function onRequest(ctx) {
  const { request, params } = ctx;
  const table = request.method === 'GET' ? GET : request.method === 'POST' ? POST : null;
  const handler = table?.[params.action];
  if (!handler) return json({ error: 'Not found' }, 404);
  if (!csrfOk(request)) return json({ error: 'Missing X-Tally header' }, 403);
  try {
    return await handler(ctx);
  } catch (err) {
    if (err instanceof SyntaxError || err?.message === 'too large') return json({ error: 'Invalid request' }, 400);
    console.error('auth error', params.action, err);
    return json({ error: 'Something went wrong' }, 500);
  }
}
