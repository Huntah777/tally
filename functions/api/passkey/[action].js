/* ============================================================
   Tally — /api/passkey/:action   (Face ID / Touch ID / Windows Hello)
   ------------------------------------------------------------
   Signed in:
     POST /api/passkey/register-options          → PublicKeyCredentialCreationOptions (base64url)
     POST /api/passkey/register  { challengeId, id, clientDataJSON, authenticatorData,
                                   publicKey, alg, name? }        → { ok }
     POST /api/passkey/remove    { id }          → { ok }
   Signed out:
     POST /api/passkey/login-options             → PublicKeyCredentialRequestOptions
     POST /api/passkey/login     { challengeId, id, clientDataJSON, authenticatorData,
                                   signature }   → { user }

   Login is username-less: the passkey is discoverable, so the browser offers
   the account itself and we look the credential up by its id.
   ============================================================ */
import { json, csrfOk, currentUser, startSession, readJson, throttled, recordFailure } from '../../_lib/auth.js';
import { rpFor, issueChallenge, consumeChallenge, verifyRegistration, verifyAssertion, ALGS, b64url } from '../../_lib/webauthn.js';

const MAX_PASSKEYS = 10;
const enc = new TextEncoder();

async function registerOptions({ request, env, user }) {
  const rp = rpFor(request);
  const { challengeId, challenge } = await issueChallenge(env, user.id);
  const existing = await env.DB.prepare('SELECT id FROM passkeys WHERE user_id = ?').bind(user.id).all();
  return json({
    challengeId,
    publicKey: {
      challenge,
      rp: { id: rp.id, name: 'Tally' },
      user: { id: b64url(enc.encode(user.id)), name: user.email, displayName: user.email },
      pubKeyCredParams: ALGS.map((alg) => ({ type: 'public-key', alg })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      attestation: 'none',
      timeout: 120000,
      excludeCredentials: (existing.results || []).map((r) => ({ type: 'public-key', id: r.id })),
    },
  });
}

async function register({ request, env, user }) {
  const body = await readJson(request, 32_768);
  const expected = await consumeChallenge(env, body.challengeId);
  if (!expected || expected.user_id !== user.id) return json({ error: 'Passkey request expired — try again' }, 400);

  const count = (await env.DB.prepare('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?').bind(user.id).first())?.n || 0;
  if (count >= MAX_PASSKEYS) return json({ error: `You can have up to ${MAX_PASSKEYS} passkeys` }, 400);

  const result = await verifyRegistration({ body, expected, rp: rpFor(request) });
  if (result.error) return json({ error: result.error }, 400);

  const name = String(body.name || 'Passkey').slice(0, 60);
  await env.DB.prepare(
    `INSERT INTO passkeys (id, user_id, public_key, alg, sign_count, name, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(String(body.id), user.id, String(body.publicKey), result.alg, result.signCount, name, Date.now()).run();
  return json({ ok: true });
}

async function remove({ request, env, user }) {
  const body = await readJson(request);
  await env.DB.prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ?').bind(String(body.id || ''), user.id).run();
  return json({ ok: true });
}

async function loginOptions({ request, env }) {
  const rp = rpFor(request);
  const { challengeId, challenge } = await issueChallenge(env, null);
  return json({
    challengeId,
    publicKey: { challenge, rpId: rp.id, userVerification: 'required', timeout: 120000, allowCredentials: [] },
  });
}

async function login({ request, env }) {
  if (await throttled(request, env, null)) return json({ error: 'Too many attempts — wait 15 minutes' }, 429);
  const body = await readJson(request, 32_768);
  const expected = await consumeChallenge(env, body.challengeId);
  if (!expected) return json({ error: 'Passkey request expired — try again' }, 400);

  const passkey = await env.DB.prepare('SELECT * FROM passkeys WHERE id = ?').bind(String(body.id || '')).first();
  if (!passkey) {
    await recordFailure(request, env, null);
    return json({ error: 'That passkey isn’t registered here any more. Sign in with your password.' }, 401);
  }
  const result = await verifyAssertion({ body, expected, rp: rpFor(request), passkey });
  if (result.error) {
    await recordFailure(request, env, null);
    return json({ error: 'Passkey sign-in failed' }, 401);
  }
  await env.DB.prepare('UPDATE passkeys SET sign_count = ?, last_used = ? WHERE id = ?')
    .bind(result.signCount, Date.now(), passkey.id).run();

  const user = await env.DB.prepare('SELECT id, email FROM users WHERE id = ?').bind(passkey.user_id).first();
  const cookie = await startSession(request, env, user.id);
  return json({ user }, 200, { 'Set-Cookie': cookie });
}

const SIGNED_IN  = { 'register-options': registerOptions, register, remove };
const SIGNED_OUT = { 'login-options': loginOptions, login };

export async function onRequestPost(ctx) {
  const { request, env, params } = ctx;
  if (!csrfOk(request)) return json({ error: 'Missing X-Tally header' }, 403);
  try {
    if (SIGNED_OUT[params.action]) return await SIGNED_OUT[params.action](ctx);
    if (SIGNED_IN[params.action]) {
      const user = await currentUser(request, env);
      if (!user) return json({ error: 'Unauthorized' }, 401);
      return await SIGNED_IN[params.action]({ ...ctx, user });
    }
    return json({ error: 'Not found' }, 404);
  } catch (err) {
    if (err instanceof SyntaxError || err?.message === 'too large') return json({ error: 'Invalid request' }, 400);
    console.error('passkey error', params.action, err);
    return json({ error: 'Something went wrong' }, 500);
  }
}
