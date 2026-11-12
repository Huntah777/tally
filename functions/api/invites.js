/* ============================================================
   Tally — /api/invites   (personal invite links)
   ------------------------------------------------------------
   GET    /api/invites             → { inviteOnly, invites: [{ code, url, label, uses, created_at, last_used }] }
   POST   /api/invites { label? }  → { code, url }
   DELETE /api/invites?code=…      → { ok }   (revokes; people who joined keep their accounts)

   Signed-in users only. A link looks like https://…/?invite=k3vd-82qm-tq7c:
   opening it goes straight to "Create account" with the code filled in.
   ============================================================ */
import { json, withUser, readJson, randomBytes } from '../_lib/auth.js';

const MAX_ACTIVE = 10;
/* No 0/o/1/l/i, so a code read aloud or retyped from a screenshot works. */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const newCode = () => {
  const b = randomBytes(12);
  return [...b].map((x) => ALPHABET[x % ALPHABET.length]).join('').match(/.{4}/g).join('-');
};

export const onRequest = withUser(async ({ request, env, user }) => {
  const origin = new URL(request.url).origin;
  const link = (code) => `${origin}/?invite=${code}`;

  if (request.method === 'GET') {
    const r = await env.DB.prepare(
      'SELECT code, label, uses, created_at, last_used FROM invites WHERE created_by = ? AND revoked_at IS NULL ORDER BY created_at DESC'
    ).bind(user.id).all();
    return json({
      inviteOnly: !!(env.SIGNUP_CODE || '').trim(),
      invites: (r.results || []).map((i) => ({ ...i, url: link(i.code) })),
    });
  }

  if (request.method === 'POST') {
    let body = {};
    try { body = await readJson(request); } catch {}
    const n = (await env.DB.prepare('SELECT COUNT(*) AS n FROM invites WHERE created_by = ? AND revoked_at IS NULL').bind(user.id).first())?.n || 0;
    if (n >= MAX_ACTIVE) return json({ error: `You can have up to ${MAX_ACTIVE} invite links. Turn one off first.` }, 400);
    const code = newCode();
    await env.DB.prepare('INSERT INTO invites (code, created_by, label, created_at) VALUES (?, ?, ?, ?)')
      .bind(code, user.id, String(body.label || '').trim().slice(0, 60) || null, Date.now()).run();
    return json({ code, url: link(code) }, 201);
  }

  if (request.method === 'DELETE') {
    const code = String(new URL(request.url).searchParams.get('code') || '').trim().toLowerCase();
    await env.DB.prepare('UPDATE invites SET revoked_at = ? WHERE code = ? AND created_by = ?').bind(Date.now(), code, user.id).run();
    return json({ ok: true });
  }

  return json({ error: 'Method not allowed' }, 405);
});
