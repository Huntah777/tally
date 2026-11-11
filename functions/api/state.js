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
                        (see mergeState) and stores the result.
                        Add ?return=merged to get the merged blob back.

   All requests require a signed-in session cookie (and PUT the X-Tally
   header — see withUser in _lib/auth.js).

   Same design as Folio, one row per user instead of one row total: a JSON
   blob merged on every write so a phone and a laptop logging at the same
   time can't clobber each other.
   ============================================================ */

import { json, withUser } from '../_lib/auth.js';

const MAX_BODY_BYTES     = 5 * 1024 * 1024; /* 5 MB — years of food log fits easily */
const MAX_WRITE_ATTEMPTS = 3;               /* optimistic-concurrency retries */
const TOMBSTONE_TTL_MS   = 90 * 24 * 60 * 60 * 1000; /* 90 days */

/* Collections carrying soft-delete tombstones in a sibling `<key>Deleted` array.
   Must stay in step with TOMBSTONED in lib/engine.js. */
const TOMBSTONED = ['entries', 'weights', 'foods'];

const stampOf   = (it) => Number(it?.updated ?? it?.created ?? 0) || 0;
const tombStamp = (t)  => Number(t?.deletedAt ?? 0) || 0;

/* Per-item last-write-wins across items and tombstones. A newer edit beats an
   older tombstone and vice versa; on an exact tie the tombstone wins. Absence
   is never read as a delete — a device that hasn't heard about an item yet
   simply pushes a payload without it. */
function mergeTombstoned(existingItems, incomingItems, existingTombs, incomingTombs, now) {
  const winners = new Map();
  const consider = (id, ts, kind, value) => {
    if (id === undefined || id === null) return;
    const cur = winners.get(id);
    if (!cur || ts >= cur.ts) winners.set(id, { ts, kind, value });
  };
  for (const it of existingItems || []) consider(it?.id, stampOf(it), 'item', it);
  for (const it of incomingItems || []) consider(it?.id, stampOf(it), 'item', it);
  for (const t of existingTombs  || []) consider(t?.id, tombStamp(t), 'tomb', t);
  for (const t of incomingTombs  || []) consider(t?.id, tombStamp(t), 'tomb', t);

  const items = [], tombstones = [];
  for (const w of winners.values()) {
    if (w.kind === 'item') items.push(w.value);
    else if (now - tombStamp(w.value) <= TOMBSTONE_TTL_MS) tombstones.push(w.value);
  }
  return { items, tombstones };
}

/* The profile is small but every field matters (a stale height silently
   shifts every target), so it is whole-object last-write-wins by `updated`
   rather than a key-by-key splice of two different people's edits. */
const newer = (a, b) => (Number(b?.updated || 0) >= Number(a?.updated || 0) ? b : a);

export function mergeState(existing, incoming, now = Date.now()) {
  const out = { ...existing, ...incoming };

  for (const key of TOMBSTONED) {
    const tKey = key + 'Deleted';
    const { items, tombstones } = mergeTombstoned(
      existing[key], incoming[key], existing[tKey], incoming[tKey], now,
    );
    out[key]  = items;
    out[tKey] = tombstones;
  }

  if (existing.profile || incoming.profile) out.profile = newer(existing.profile, incoming.profile);
  /* Receipt-line → food mappings Tally has learned. Keys never conflict in a
     way that matters (the latest mapping for a line is as good as any). */
  out.aliases = { ...(existing.aliases || {}), ...(incoming.aliases || {}) };
  out.ui = { ...(existing.ui || {}), ...(incoming.ui || {}) };
  return out;
}

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

      for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
        const existingRow = await env.DB.prepare('SELECT data, updated_at FROM state WHERE user_id = ?').bind(user.id).first();
        let existingData = {};
        try { existingData = existingRow?.data ? JSON.parse(existingRow.data) : {}; } catch {}
        const existingUpdatedAt = existingRow?.updated_at ?? 0;

        const merged     = mergeState(existingData, body);
        const serialised = JSON.stringify(merged);
        if (serialised.length > MAX_BODY_BYTES) return json({ error: 'Payload too large' }, 413);

        /* Strictly monotonic so the ETag built from it never repeats. */
        const now = Math.max(Date.now(), existingUpdatedAt + 1);
        const ok  = () => json(
          { ok: true, updated_at: now, ...(wantMerged ? { data: merged } : {}) },
          200,
          { ETag: `"v${now}"` },
        );

        if (!existingRow) {
          /* First save for this user. A concurrent first save loses the
             PRIMARY KEY race and retries as an update. */
          try {
            await env.DB.prepare('INSERT INTO state (user_id, data, updated_at) VALUES (?, ?, ?)')
              .bind(user.id, serialised, now).run();
            return ok();
          } catch { continue; }
        }

        const result = await env.DB.prepare(
          'UPDATE state SET data = ?, updated_at = ? WHERE user_id = ? AND updated_at = ?'
        ).bind(serialised, now, user.id, existingUpdatedAt).run();
        if (result.meta.changes > 0) return ok();
      }
      return json({ error: 'Too many concurrent writes, please retry' }, 409);
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch (err) {
    console.error('state handler error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
});
