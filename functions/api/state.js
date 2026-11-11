/* ============================================================
   Tally · Calorie Deficit — /api/state
   ------------------------------------------------------------
   Cloudflare Pages Function. Auto-routed to /api/state.

   Bindings (Pages → Settings → Bindings):
     env.DB           D1 database binding  (binding name: DB)

   Endpoints:
     GET  /api/state  → stored state JSON (or {} on first run).
                        Honours If-None-Match → 304 when unchanged.
     PUT  /api/state  → MERGES the incoming state into the stored state
                        (see mergeState in _lib/state.js) and stores it.
                        Add ?return=merged to get the merged blob back.

   All requests require a signed-in session cookie (and PUT the X-Tally
   header — see withUser in _lib/auth.js).

   Same design as Folio, one row per user instead of one row total: a JSON
   blob merged on every write so a phone and a laptop logging at the same
   time can't clobber each other.
   ============================================================ */

import { json, withUser } from '../_lib/auth.js';
import { MAX_BODY_BYTES, writeMerged } from '../_lib/state.js';

export { mergeState } from '../_lib/state.js';

export const onRequest = withUser(async ({ request, env, user }) => {
  try {
    if (request.method === 'GET') {
      const row = await env.DB.prepare('SELECT data, updated_at FROM state WHERE user_id = ?').bind(user.id).first();
      if (!row || !row.data) return json({});
      const etag = `"v${row.updated_at ?? 0}"`;
      if (request.headers.get('If-None-Match') === etag) {
        return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': 'no-store' } });
      }
      try { return json(JSON.parse(row.data), 200, { ETag: etag }); }
      catch { return json({}); }
    }

    if (request.method === 'PUT') {
      const cl = request.headers.get('Content-Length');
      if (cl && Number(cl) > MAX_BODY_BYTES) return json({ error: 'Payload too large' }, 413);

      const raw = await request.text();
      if (raw.length > MAX_BODY_BYTES) return json({ error: 'Payload too large' }, 413);

      let body;
      try { body = JSON.parse(raw); }
      catch { return json({ error: 'Invalid JSON' }, 400); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Invalid JSON' }, 400);

      const wantMerged = new URL(request.url).searchParams.get('return') === 'merged';
      const r = await writeMerged(env, user.id, () => body);
      if (!r.ok) return json({ error: r.error }, r.status);
      return json(
        { ok: true, updated_at: r.updatedAt, ...(wantMerged ? { data: r.merged } : {}) },
        200,
        { ETag: `"v${r.updatedAt}"` },
      );
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch (err) {
    console.error('state handler error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
});
