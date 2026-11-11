/* ============================================================
   Tally — /api/tokens   (sync keys for the Apple Health Shortcut)
   ------------------------------------------------------------
   GET    /api/tokens            → { tokens: [{ id, label, prefix, created_at, last_used }] }
   POST   /api/tokens { label }  → { token, id }   the key itself, shown ONCE
   DELETE /api/tokens?id=…       → { ok }

   Signed-in users only. A key can only write Apple Health numbers through
   /api/ingest — it can't read the food log or sign in as the user.
   ============================================================ */
import { json, withUser, readJson, randomId, sha256hex } from '../_lib/auth.js';

const MAX_TOKENS = 5;

export const onRequest = withUser(async ({ request, env, user }) => {
  if (request.method === 'GET') {
    const r = await env.DB.prepare(
      'SELECT token_hash, label, prefix, created_at, last_used FROM api_tokens WHERE user_id = ? ORDER BY created_at'
    ).bind(user.id).all();
    /* The hash is the row id here; it's not secret (the key can't be derived
       from it), and it's what the client sends back to revoke. */
    return json({ tokens: (r.results || []).map((t) => ({ id: t.token_hash, label: t.label, prefix: t.prefix, created_at: t.created_at, last_used: t.last_used })) });
  }

  if (request.method === 'POST') {
    let body = {};
    try { body = await readJson(request); } catch {}
    const n = (await env.DB.prepare('SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = ?').bind(user.id).first())?.n || 0;
    if (n >= MAX_TOKENS) return json({ error: `You can have up to ${MAX_TOKENS} sync keys — remove one first` }, 400);
    const token = 'tly_' + randomId(24);
    const id = await sha256hex(token);
    await env.DB.prepare('INSERT INTO api_tokens (token_hash, user_id, label, prefix, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(id, user.id, String(body.label || 'Apple Health Shortcut').slice(0, 60), token.slice(0, 8), Date.now()).run();
    /* The ready-made link the Shortcut posts to: one thing to paste. */
    const url = `${new URL(request.url).origin}/api/ingest?key=${token}`;
    return json({ token, id, url }, 201);
  }

  if (request.method === 'DELETE') {
    const id = new URL(request.url).searchParams.get('id') || '';
    await env.DB.prepare('DELETE FROM api_tokens WHERE token_hash = ? AND user_id = ?').bind(id, user.id).run();
    return json({ ok: true });
  }

  return json({ error: 'Method not allowed' }, 405);
});
